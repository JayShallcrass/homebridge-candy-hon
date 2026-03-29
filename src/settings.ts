export const PLATFORM_NAME = 'CandyHon';
export const PLUGIN_NAME = 'homebridge-candy-hon';

export const AUTH_API = 'https://account2.hon-smarthome.com';
export const API_URL = 'https://api-iot.he.services';

export const CLIENT_ID = '3MVG9QDx8IX8nP5T2Ha8ofvlmjLZl5L_gvfbT9.HJvpHGKoAS_dcMN8LYpTSYeVFCraUnV.2Ag1Ki7m4znVO6';
export const APP_VERSION = '2.6.5';
export const OS_VERSION = 999;

export const TOKEN_EXPIRES_HOURS = 8;
export const TOKEN_REFRESH_HOURS = 7;

export const DEFAULT_POLL_INTERVAL = 60;
export const MIN_POLL_INTERVAL = 30;

export const MACHINE_MODES: Record<string, string> = {
  '0': 'idle',
  '1': 'idle',
  '2': 'running',
  '3': 'paused',
  '4': 'delayed',
  '5': 'finished',
  '6': 'error',
  '7': 'finished',
};
