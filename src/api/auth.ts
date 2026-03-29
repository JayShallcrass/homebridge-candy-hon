import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { Logger } from 'homebridge';
import { AUTH_API, API_URL, CLIENT_ID, APP_VERSION, OS_VERSION, TOKEN_REFRESH_HOURS } from '../settings';
import { HonTokens } from './types';

export class HonAuth {
  private tokens: HonTokens | null = null;
  private mobileId: string;
  private cookies: Record<string, string> = {};

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly log: Logger,
  ) {
    this.mobileId = crypto.randomUUID();
  }

  get cognitoToken(): string {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }
    return this.tokens.cognitoToken;
  }

  get idToken(): string {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }
    return this.tokens.idToken;
  }

  get shouldRefresh(): boolean {
    if (!this.tokens) {
      return true;
    }
    const refreshAt = this.tokens.tokenExpiry - (60 * 60 * 1000); // 1 hour before expiry
    return Date.now() > refreshAt;
  }

  async authenticate(): Promise<void> {
    this.log.info('Authenticating with hOn...');
    this.cookies = {};

    try {
      // Build OAuth query string manually (URLSearchParams encodes + as %2B which Salesforce rejects)
      const nonce = crypto.randomUUID();
      const authorizeQs = [
        'response_type=token+id_token',
        `client_id=${CLIENT_ID}`,
        `redirect_uri=${encodeURIComponent('hon://mobilesdk/detect/oauth/done')}`,
        'display=touch',
        'scope=api+openid+refresh_token+web',
        `nonce=${nonce}`,
      ].join('&');
      const authorizeUrl = `${AUTH_API}/services/oauth2/authorize/expid_Login?${authorizeQs}`;

      // Step 1: Follow OAuth authorize redirects to reach the login page
      this.log.info('Auth: Getting login page...');
      const loginPageResult = await this.followRedirects(authorizeUrl);
      let html = this.bodyString(loginPageResult.response);

      // The login page may not have fwuid inline; fetch /s/login/ directly
      let fwuidMatch = html.match(/fwuid['"]\s*:\s*['"]([^'"]+)['"]/);
      if (!fwuidMatch) {
        this.log.debug('Auth: fwuid not on redirect page, fetching /s/login/ directly...');
        const directLogin = await this.followRedirects(`${AUTH_API}/s/login/`);
        html = this.bodyString(directLogin.response);
        fwuidMatch = html.match(/fwuid['"]\s*:\s*['"]([^'"]+)['"]/);
      }

      if (!fwuidMatch) {
        throw new Error('Could not find fwuid on login page');
      }
      const fwuid = fwuidMatch[1];

      let loaded: Record<string, unknown> = {};
      const loadedMatch = html.match(/"loaded"\s*:\s*(\{[^}]+\})/);
      if (loadedMatch) {
        try { loaded = JSON.parse(loadedMatch[1]); } catch { /* ignore */ }
      }

      // Step 2: Submit login credentials via Salesforce Aura
      this.log.info('Auth: Submitting credentials...');
      const message = JSON.stringify({
        actions: [{
          id: '84;a',
          descriptor: 'apex://LightningLoginCustomController/ACTION$login',
          callingDescriptor: 'markup://c:honaborLoginForm',
          params: { username: this.email, password: this.password, startUrl: '' },
        }],
      });

      const loginResp = await this.request('POST', `${AUTH_API}/s/sfsites/aura`, {
        data: new URLSearchParams({
          message,
          'aura.context': JSON.stringify({
            mode: 'PROD', fwuid, app: 'siteforce:loginApp2', loaded, dn: [], globals: {}, uad: false,
          }),
          'aura.pageURI': '/s/login/',
          'aura.token': 'null',
        }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      // Extract redirect URL from Aura response
      let redirectUrl = '';
      const loginData = loginResp.data;
      if (typeof loginData === 'object' && loginData.events) {
        for (const event of loginData.events) {
          if (event.attributes?.values?.url) {
            redirectUrl = event.attributes.values.url;
            break;
          }
        }
      }
      if (!redirectUrl) {
        throw new Error('Login failed: no redirect URL. Check email and password.');
      }

      // Step 3: Follow frontdoor.jsp chain (sets session cookies)
      this.log.info('Auth: Following session chain...');
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = `${AUTH_API}${redirectUrl}`;
      }
      await this.followRedirects(redirectUrl);

      // Step 4: Re-authorize with session cookies to get tokens
      this.log.info('Auth: Getting tokens...');
      const authResult = await this.followRedirects(authorizeUrl);
      if (!authResult.tokenUrl) {
        throw new Error('Re-authorize did not return tokens');
      }

      const fragment = authResult.tokenUrl.split('#')[1] || '';
      const params = new URLSearchParams(fragment);
      const accessToken = params.get('access_token') || '';
      const refreshToken = params.get('refresh_token') || '';
      const idTokenValue = params.get('id_token') || '';

      if (!accessToken || !idTokenValue) {
        throw new Error('Missing access_token or id_token in response');
      }

      // Step 5: Exchange id_token for cognito token
      this.log.info('Auth: Getting API token...');
      const cognitoResp = await axios.post(`${API_URL}/auth/v1/login`, {
        appVersion: APP_VERSION,
        mobileId: this.mobileId,
        os: 'android',
        osVersion: OS_VERSION,
        deviceModel: 'homebridge-candy-hon',
      }, {
        headers: {
          'id-token': idTokenValue,
          'Content-Type': 'application/json',
          'User-Agent': 'Chrome/999.999.999.999',
        },
        timeout: 15000,
      });

      const cognitoToken = cognitoResp.data?.cognitoUser?.Token;
      if (!cognitoToken) {
        throw new Error('Could not obtain cognito token');
      }

      this.tokens = {
        accessToken,
        refreshToken,
        idToken: idTokenValue,
        cognitoToken,
        tokenExpiry: Date.now() + (TOKEN_REFRESH_HOURS * 60 * 60 * 1000),
      };

      this.log.info('Authentication successful');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.log.error('Authentication failed:', error.message, 'Status:', error.response?.status, 'URL:', error.config?.url);
      } else {
        this.log.error('Authentication failed:', error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async refreshTokens(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      return this.authenticate();
    }
    this.log.debug('Refreshing tokens...');
    try {
      const response = await axios.post(`${AUTH_API}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: this.tokens.refreshToken,
        }).toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        },
      );

      const idTokenValue = response.data.id_token;
      const cognitoResp = await axios.post(`${API_URL}/auth/v1/login`, {
        appVersion: APP_VERSION, mobileId: this.mobileId, os: 'android', osVersion: OS_VERSION, deviceModel: 'homebridge-candy-hon',
      }, {
        headers: { 'id-token': idTokenValue, 'Content-Type': 'application/json', 'User-Agent': 'Chrome/999.999.999.999' },
        timeout: 15000,
      });

      this.tokens = {
        ...this.tokens,
        idToken: idTokenValue,
        cognitoToken: cognitoResp.data?.cognitoUser?.Token || this.tokens.cognitoToken,
        tokenExpiry: Date.now() + (TOKEN_REFRESH_HOURS * 60 * 60 * 1000),
      };
      this.log.debug('Token refresh successful');
    } catch {
      this.log.warn('Token refresh failed, re-authenticating...');
      return this.authenticate();
    }
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.tokens) {
      return this.authenticate();
    }
    if (this.shouldRefresh) {
      return this.refreshTokens();
    }
  }

  // HTTP request with cookie tracking
  private async request(
    method: string,
    url: string,
    opts?: { data?: string; headers?: Record<string, string> },
  ): Promise<AxiosResponse> {
    const resp = await axios({
      method,
      url,
      data: opts?.data,
      headers: {
        Cookie: this.getCookieString(),
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        ...opts?.headers,
      },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 15000,
    });
    this.parseCookies(resp.headers['set-cookie']);
    return resp;
  }

  // Follow redirect chain (HTTP and JS redirects) with cookie tracking
  private async followRedirects(url: string): Promise<{ url: string; response: AxiosResponse; tokenUrl?: string }> {
    let currentUrl = url;
    for (let i = 0; i < 20; i++) {
      const resp = await this.request('GET', currentUrl);
      const loc = resp.headers.location || '';

      // Check for hon:// token redirect
      if (loc.startsWith('hon://') && loc.includes('access_token')) {
        return { url: loc, response: resp, tokenUrl: loc };
      }

      // HTTP redirect
      if (resp.status >= 300 && resp.status < 400 && loc) {
        currentUrl = loc.startsWith('http') ? loc : AUTH_API + loc;
        continue;
      }

      // JS redirect in HTML body
      const body = this.bodyString(resp);
      const jsMatch = body.match(/location\.replace\(['"]([^'"]+)['"]\)/) ||
                      body.match(/handleRedirect\('([^']+)'\)/);
      if (jsMatch) {
        const target = jsMatch[1];
        if (target.startsWith('hon://') && target.includes('access_token')) {
          return { url: target, response: resp, tokenUrl: target };
        }
        currentUrl = target.startsWith('http') ? target : AUTH_API + target;
        continue;
      }

      return { url: currentUrl, response: resp };
    }
    throw new Error('Too many redirects');
  }

  private parseCookies(setCookieHeaders: string[] | undefined): void {
    if (!setCookieHeaders) {
      return;
    }
    for (const header of setCookieHeaders) {
      const nameValue = header.split(';')[0];
      const eqIndex = nameValue.indexOf('=');
      if (eqIndex > 0) {
        const name = nameValue.substring(0, eqIndex).trim();
        const value = nameValue.substring(eqIndex + 1);
        this.cookies[name] = value;
      }
    }
  }

  private getCookieString(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private bodyString(resp: AxiosResponse): string {
    return typeof resp.data === 'string' ? resp.data : '';
  }
}
