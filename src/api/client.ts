import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';
import { API_URL, APP_VERSION, MACHINE_MODES } from '../settings';
import { HonAuth } from './auth';
import { HonAppliance, HonApplianceContext, HonDeviceState } from './types';

const FRIENDLY_NAMES: Record<string, string> = {
  WM: 'Washing Machine',
  WD: 'Washer Dryer',
  TD: 'Tumble Dryer',
  DW: 'Dishwasher',
  OV: 'Oven',
  REF: 'Fridge',
  AC: 'Air Conditioner',
};

export class HonApiClient {
  private http: AxiosInstance;

  constructor(
    private readonly auth: HonAuth,
    private readonly log: Logger,
  ) {
    this.http = axios.create({
      baseURL: API_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Chrome/999.999.999.999',
      },
    });

    this.http.interceptors.request.use(async (config) => {
      await this.auth.ensureAuthenticated();
      config.headers['cognito-token'] = this.auth.cognitoToken;
      config.headers['id-token'] = this.auth.idToken;
      return config;
    });

    this.http.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 || error.response?.status === 403) {
          this.log.warn('API returned 401/403, refreshing tokens...');
          await this.auth.refreshTokens();
          const config = error.config;
          config.headers['cognito-token'] = this.auth.cognitoToken;
          config.headers['id-token'] = this.auth.idToken;
          return this.http.request(config);
        }
        throw error;
      },
    );
  }

  async getAppliances(): Promise<HonAppliance[]> {
    this.log.debug('Fetching appliances...');

    const response = await this.http.get('/commands/v1/appliance');
    const payload = response.data?.payload;

    if (!payload?.appliances) {
      this.log.warn('No appliances found in response');
      return [];
    }

    const appliances: HonAppliance[] = payload.appliances.map((a: Record<string, unknown>) => {
      const typeCode = (a.applianceType as string) || (a.applianceTypeName as string) || '';
      const friendlyName = FRIENDLY_NAMES[typeCode] || (a.nickName as string) || typeCode || 'Appliance';
      this.log.debug('Appliance raw data:', JSON.stringify(a).substring(0, 500));
      return {
        macAddress: a.macAddress as string,
        applianceName: friendlyName,
        applianceType: typeCode,
        applianceModelId: (a.applianceModelId as string) || '',
        serialNumber: (a.serialNumber as string) || '',
        brand: (a.brand as string) || 'Candy',
        model: (a.modelName as string) || (a.applianceModelId as string) || '',
        firmwareVersion: (a.fwVersion as string) || undefined,
        topics: a.topics as { subscribe: string[] } | undefined,
      };
    });

    this.log.info(`Found ${appliances.length} appliance(s)`);
    return appliances;
  }

  async getApplianceContext(macAddress: string, applianceType: string, applianceModelId?: string): Promise<HonApplianceContext> {
    this.log.debug(`Fetching context for ${macAddress}...`);

    const params: Record<string, string> = { macAddress, applianceType, category: 'CYCLE' };
    if (applianceModelId) {
      params.applianceModelId = applianceModelId;
    }

    let response;
    try {
      response = await this.http.get('/commands/v1/context', { params });
    } catch {
      this.log.debug('Context endpoint failed, trying last-activity...');
      response = await this.http.get('/commands/v1/retrieve-last-activity', {
        params: { macAddress, applianceType },
      });
    }

    const parameters: Record<string, string> = {};
    const attrs = response.data?.payload?.shadow?.parameters
      || response.data?.payload?.activity
      || response.data?.payload;

    if (attrs) {
      if (Array.isArray(attrs)) {
        for (const param of attrs) {
          parameters[param.parName || param.name] = String(param.parValue || param.value || '');
        }
      } else if (typeof attrs === 'object') {
        for (const [key, value] of Object.entries(attrs)) {
          if (value !== null && typeof value === 'object') {
            // hOn API returns params as objects like { parNewVal: "7", ... }
            const obj = value as Record<string, unknown>;
            const extracted = obj.parNewVal ?? obj.parValue ?? obj.value ?? obj.defaultValue ?? '';
            parameters[key] = String(extracted);
          } else {
            parameters[key] = String(value ?? '');
          }
        }
      }
    }

    return { macAddress, parameters };
  }

  async sendCommand(
    macAddress: string,
    applianceType: string,
    commandName: string,
    parameters: Record<string, string>,
    programName?: string,
  ): Promise<boolean> {
    this.log.info(`Sending command ${commandName} to ${macAddress}`);

    const timestamp = new Date().toISOString();

    const payload = {
      macAddress,
      timestamp,
      commandName,
      transactionId: `${macAddress}_${timestamp}`,
      applianceOptions: {},
      device: {
        appVersion: APP_VERSION,
        mobileId: 'homebridge-candy-hon',
        mobileOs: 'android',
        osVersion: '14',
        deviceModel: 'homebridge',
      },
      attributes: {
        channel: 'mobileApp',
        origin: 'standardProgram',
        energyLabel: '0',
      },
      ancillaryParameters: {},
      parameters,
      applianceType,
      programName: programName || '',
    };

    try {
      const response = await this.http.post('/commands/v1/send', payload);
      const success = response.data?.payload?.resultCode === '0' || response.status === 200;
      if (success) {
        this.log.info(`Command ${commandName} sent successfully`);
      }
      return success;
    } catch (error) {
      this.log.error(`Failed to send command ${commandName}:`, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  parseDeviceState(parameters: Record<string, string>): HonDeviceState {
    const machMode = parameters.machMode || '0';
    const mode = MACHINE_MODES[machMode] || 'idle';

    const remainingMinutes = parseInt(parameters.remainingTimeMM || parameters.remainTime || '0', 10);
    const remainingHours = parseInt(parameters.remainingTimeHH || '0', 10);
    const remainingTime = (remainingHours * 60 + remainingMinutes) * 60;

    return {
      machMode,
      prCode: parameters.prCode || '',
      programName: parameters.prPhase || parameters.programName || '',
      spinSpeed: parameters.spinSpeed || '0',
      remainingTime,
      doorOpen: parameters.doorStatusOpen === '1' || parameters.doorStatus === '1',
      doorLocked: parameters.doorLock === '1' || parameters.lockStatus === '1',
      error: mode === 'error' || (parameters.error !== undefined && parameters.error !== '0' && parameters.error !== ''),
      active: mode === 'running' || mode === 'delayed' || mode === 'paused',
      running: mode === 'running' || mode === 'delayed',
      paused: mode === 'paused',
      finished: mode === 'finished',
      delayed: mode === 'delayed',
      remoteControl: parameters.remoteCtrValid === '1' || parameters.remoteControl === '1',
      totalWashCycles: parseInt(parameters.totalWashCycle || '0', 10),
      totalElectricity: parseFloat(parameters.totalElectricityUsed || '0'),
      totalWater: parseFloat(parameters.totalWaterUsed || '0'),
    };
  }
}
