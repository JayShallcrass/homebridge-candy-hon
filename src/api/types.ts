export interface HonConfig {
  name: string;
  email: string;
  password: string;
  pollInterval?: number;
  enableRemoteStart?: boolean;
  pushcutWebhookUrl?: string;
}

export interface HonTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  cognitoToken: string;
  tokenExpiry: number;
}

export interface HonAppliance {
  macAddress: string;
  applianceName: string;
  applianceType: string;
  applianceModelId: string;
  serialNumber: string;
  brand: string;
  model: string;
  firmwareVersion?: string;
  topics?: {
    subscribe: string[];
  };
}

export interface HonApplianceContext {
  macAddress: string;
  parameters: Record<string, string>;
}

export interface HonCommand {
  commandName: string;
  parameters: Record<string, unknown>;
}

export interface HonDeviceState {
  machMode: string;
  prCode: string;
  programName: string;
  spinSpeed: string;
  remainingTime: number;
  doorOpen: boolean;
  doorLocked: boolean;
  error: boolean;
  active: boolean;
  running: boolean;
  paused: boolean;
  finished: boolean;
  delayed: boolean;
  remoteControl: boolean;
  totalWashCycles: number;
  totalElectricity: number;
  totalWater: number;
}
