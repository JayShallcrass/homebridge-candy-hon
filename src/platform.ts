import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HonAuth } from './api/auth';
import { HonApiClient } from './api/client';
import { HonConfig, HonAppliance } from './api/types';
import { WasherDryerAccessory } from './accessories/washerDryer';

export class CandyHonPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly config: HonConfig;

  private readonly accessories: PlatformAccessory[] = [];
  private readonly activeAccessories: Map<string, WasherDryerAccessory> = new Map();
  private auth: HonAuth | null = null;
  private client: HonApiClient | null = null;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as unknown as HonConfig;

    if (!this.config.email || !this.config.password) {
      this.log.error('Missing email or password in config. Plugin will not start.');
      return;
    }

    this.log.info('Initialising CandyHon platform');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    try {
      this.auth = new HonAuth(this.config.email, this.config.password, this.log);
      this.client = new HonApiClient(this.auth, this.log);

      await this.auth.authenticate();
      const appliances = await this.client.getAppliances();

      const discoveredUuids: string[] = [];

      for (const appliance of appliances) {
        const uuid = this.api.hap.uuid.generate(appliance.macAddress);
        discoveredUuids.push(uuid);

        const existingAccessory = this.accessories.find(a => a.UUID === uuid);

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          existingAccessory.context.device = appliance;
          // Update the display name if it changed
          existingAccessory.displayName = appliance.applianceName;
          this.api.updatePlatformAccessories([existingAccessory]);
          this.createAccessoryHandler(existingAccessory, appliance);
        } else {
          this.log.info('Adding new accessory:', appliance.applianceName);
          const accessory = new this.api.platformAccessory(
            appliance.applianceName,
            uuid,
          );
          accessory.context.device = appliance;
          this.createAccessoryHandler(accessory, appliance);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }

      // Remove stale accessories
      for (const accessory of this.accessories) {
        if (!discoveredUuids.includes(accessory.UUID)) {
          this.log.info('Removing stale accessory:', accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    } catch (error) {
      this.log.error('Failed to discover devices:', error instanceof Error ? error.message : String(error));
    }
  }

  private createAccessoryHandler(accessory: PlatformAccessory, appliance: HonAppliance): void {
    if (!this.client) {
      return;
    }

    // Clean up existing handler if any
    const existing = this.activeAccessories.get(appliance.macAddress);
    if (existing) {
      existing.stopPolling();
    }

    const supportedTypes = ['WM', 'WD', 'TD'];
    const typeOrName = appliance.applianceType || appliance.applianceName || '';
    if (!supportedTypes.some(t => typeOrName.toUpperCase().includes(t))) {
      this.log.warn(
        `Unsupported appliance type: ${appliance.applianceType} (${appliance.applianceName}). ` +
        'Only washing machines (WM), washer-dryers (WD), and tumble dryers (TD) are currently supported.',
      );
      return;
    }

    const handler = new WasherDryerAccessory(
      this,
      accessory,
      this.client,
      appliance,
      this.log,
    );

    this.activeAccessories.set(appliance.macAddress, handler);
  }
}
