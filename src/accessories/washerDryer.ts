import {
  Service,
  Characteristic,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from 'homebridge';
import { CandyHonPlatform } from '../platform';
import { HonApiClient } from '../api/client';
import { HonAppliance, HonDeviceState } from '../api/types';
import axios from 'axios';

const FINISHED_RESET_MS = 10 * 60 * 1000; // 10 minutes

export class WasherDryerAccessory {
  private valveService: Service;
  private finishedService: Service;

  private state: HonDeviceState;
  private wasRunning = false;
  private hasBeenRunning = false;
  private firstPoll = true;
  private consecutiveFinishedPolls = 0;
  private hasFiredThisCycle = false;
  private occupancyTriggered = false;
  private finishedTimeout: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly platform: CandyHonPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: HonApiClient,
    private readonly appliance: HonAppliance,
    private readonly log: Logger,
  ) {
    this.state = {
      machMode: '0',
      prCode: '',
      programName: '',
      spinSpeed: '0',
      remainingTime: 0,
      doorOpen: false,
      doorLocked: false,
      error: false,
      active: false,
      running: false,
      paused: false,
      finished: false,
      delayed: false,
      remoteControl: false,
      totalWashCycles: 0,
      totalElectricity: 0,
      totalWater: 0,
    };

    // Accessory information
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, appliance.brand)
      .setCharacteristic(this.platform.Characteristic.Model, appliance.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, appliance.serialNumber || appliance.macAddress)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, appliance.firmwareVersion || '1.0.0');

    // Primary service: Valve (washer status + remaining time)
    this.valveService = this.accessory.getService(this.platform.Service.Valve)
      || this.accessory.addService(this.platform.Service.Valve, appliance.applianceName);

    this.valveService.setCharacteristic(
      this.platform.Characteristic.ValveType,
      this.platform.Characteristic.ValveType.WATER_FAUCET,
    );

    this.valveService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.valveService.getCharacteristic(this.platform.Characteristic.InUse)
      .onGet(this.getInUse.bind(this));

    this.valveService.getCharacteristic(this.platform.Characteristic.SetDuration)
      .setProps({ maxValue: 86400 })
      .onGet(() => this.state.remainingTime)
      .onSet(() => { /* ignore - duration is set by the machine */ });

    this.valveService.getCharacteristic(this.platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 86400 })
      .onGet(this.getRemainingDuration.bind(this));

    // Remove door sensor if it exists from a previous version (door status not available via REST API)
    const existingDoor = this.accessory.getService('Door');
    if (existingDoor) {
      this.accessory.removeService(existingDoor);
    }

    // Program finished trigger: OccupancySensor
    this.finishedService = this.accessory.getService('Program Finished')
      || this.accessory.addService(this.platform.Service.OccupancySensor, 'Program Finished', 'finished');

    this.finishedService.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(() => this.occupancyTriggered ? 1 : 0);

    // Start polling
    this.startPolling();
  }

  private startPolling(): void {
    this.log.info(`Starting status polling for ${this.appliance.applianceName} every ${this.platform.config.pollInterval || 60}s`);
    // Initial fetch
    this.pollStatus();

    const interval = (this.platform.config.pollInterval || 60) * 1000;
    this.pollTimer = setInterval(() => this.pollStatus(), interval);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.finishedTimeout) {
      clearTimeout(this.finishedTimeout);
      this.finishedTimeout = null;
    }
  }

  private async pollStatus(): Promise<void> {
    try {
      this.log.debug(`Polling ${this.appliance.applianceName}...`);
      const context = await this.client.getApplianceContext(
        this.appliance.macAddress,
        this.appliance.applianceType,
        this.appliance.applianceModelId,
      );

      this.log.debug(`Got ${Object.keys(context.parameters).length} parameters`);
      const newState = this.client.parseDeviceState(context.parameters);
      this.log.debug('Status: mode=' + newState.machMode + ' active=' + newState.active + ' running=' + newState.running + ' finished=' + newState.finished + ' remain=' + newState.remainingTime + 's error=' + context.parameters.error);
      this.updateState(newState);
    } catch (error) {
      this.log.error(
        `Failed to poll status for ${this.appliance.applianceName}:`,
        error instanceof Error ? error.message : String(error),
      );

      // Show fault state on communication error
      this.valveService.updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        this.platform.Characteristic.StatusFault.GENERAL_FAULT,
      );
    }
  }

  updateState(newState: HonDeviceState): void {
    const previouslyRunning = this.wasRunning;
    const wasFinished = this.state.finished;
    const previousMode = this.state.machMode;

    // Log mode transitions for debugging ghost triggers
    if (newState.machMode !== previousMode) {
      this.log.info(
        `${this.appliance.applianceName}: Mode transition ${previousMode} -> ${newState.machMode} ` +
        `(hasBeenRunning=${this.hasBeenRunning}, consecutiveFinished=${this.consecutiveFinishedPolls})`,
      );
    }

    this.state = newState;

    // Update Valve service
    this.valveService.updateCharacteristic(
      this.platform.Characteristic.Active,
      newState.active
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE,
    );

    this.valveService.updateCharacteristic(
      this.platform.Characteristic.InUse,
      newState.running
        ? this.platform.Characteristic.InUse.IN_USE
        : this.platform.Characteristic.InUse.NOT_IN_USE,
    );

    this.valveService.updateCharacteristic(
      this.platform.Characteristic.SetDuration,
      newState.running ? newState.remainingTime : 0,
    );

    this.valveService.updateCharacteristic(
      this.platform.Characteristic.RemainingDuration,
      newState.running ? newState.remainingTime : 0,
    );

    this.valveService.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      newState.error
        ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
        : this.platform.Characteristic.StatusFault.NO_FAULT,
    );


    // Track whether the machine has been through a running state this cycle
    if (newState.running) {
      this.hasBeenRunning = true;
    }

    // Debounce finished detection: require 2 consecutive polls showing finished,
    // and only trigger if the machine was actually running this cycle
    if (newState.finished) {
      this.consecutiveFinishedPolls++;
    } else {
      this.consecutiveFinishedPolls = 0;
    }

    const justFinished = newState.finished
      && !this.hasFiredThisCycle
      && !this.firstPoll
      && this.hasBeenRunning
      && this.consecutiveFinishedPolls >= 2;

    this.firstPoll = false;
    if (justFinished) {
      this.log.info(`${this.appliance.applianceName}: Program finished!`);
      this.hasFiredThisCycle = true;
      this.occupancyTriggered = true;

      this.finishedService.updateCharacteristic(
        this.platform.Characteristic.OccupancyDetected,
        this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
      );

      // Send Pushcut notification to trigger Intercom announcement
      if (this.platform.config.pushcutWebhookUrl) {
        axios.get(this.platform.config.pushcutWebhookUrl).then(() => {
          this.log.info('Pushcut notification sent');
        }).catch((err: Error) => {
          this.log.error('Pushcut notification failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Reset after 10 minutes
      if (this.finishedTimeout) {
        clearTimeout(this.finishedTimeout);
      }
      this.finishedTimeout = setTimeout(() => {
        this.occupancyTriggered = false;
        this.finishedService.updateCharacteristic(
          this.platform.Characteristic.OccupancyDetected,
          this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        );
      }, FINISHED_RESET_MS);
    }

    this.wasRunning = newState.running;

    // Reset cycle tracking when machine returns to idle
    if (!newState.active && !newState.finished) {
      this.hasBeenRunning = false;
      this.hasFiredThisCycle = false;
      this.consecutiveFinishedPolls = 0;
      this.occupancyTriggered = false;
    }

    // Log state change
    if (newState.running) {
      this.log.debug(
        `${this.appliance.applianceName}: Running (${Math.floor(newState.remainingTime / 60)}min remaining)`,
      );
    } else if (newState.finished) {
      this.log.debug(`${this.appliance.applianceName}: Finished`);
    } else if (newState.paused) {
      this.log.debug(`${this.appliance.applianceName}: Paused`);
    }
  }

  // Characteristic handlers

  private getActive(): CharacteristicValue {
    return this.state.active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const enableRemoteStart = this.platform.config.enableRemoteStart === true;

    if (!enableRemoteStart) {
      this.log.debug('Remote start is disabled. Ignoring setActive command.');
      // Revert the characteristic to current state
      setTimeout(() => {
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.Active,
          this.state.active
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );
      }, 100);
      return;
    }

    if (!this.state.remoteControl) {
      this.log.warn('Remote control is not enabled on the appliance. Enable it on the machine first.');
      setTimeout(() => {
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.Active,
          this.state.active
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );
      }, 100);
      return;
    }

    const shouldStart = value === this.platform.Characteristic.Active.ACTIVE;

    if (shouldStart && !this.state.active) {
      this.log.info(`Starting program on ${this.appliance.applianceName}`);
      await this.client.sendCommand(
        this.appliance.macAddress,
        this.appliance.applianceType,
        'startProgram',
        {},
      );
    } else if (!shouldStart && this.state.active) {
      this.log.info(`Stopping program on ${this.appliance.applianceName}`);
      await this.client.sendCommand(
        this.appliance.macAddress,
        this.appliance.applianceType,
        'stopProgram',
        {},
      );
    }
  }

  private getInUse(): CharacteristicValue {
    return this.state.running
      ? this.platform.Characteristic.InUse.IN_USE
      : this.platform.Characteristic.InUse.NOT_IN_USE;
  }

  private getRemainingDuration(): CharacteristicValue {
    return this.state.running ? this.state.remainingTime : 0;
  }
}
