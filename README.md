# homebridge-candy-hon

Homebridge plugin for Candy, Hoover, and Haier appliances via the [hOn](https://hon-smarthome.com/) cloud platform. Exposes your washing machine, washer-dryer, or tumble dryer to Apple HomeKit.

This is the first Homebridge plugin for the hOn ecosystem. The equivalent Home Assistant integration ([Andre0512/hon](https://github.com/Andre0512/hon)) has 3000+ stars -- this brings the same connectivity to HomeKit.

## Features

- **Wash cycle status** -- see if your machine is running, paused, or finished in Apple Home
- **Remaining time countdown** -- HomeKit displays the remaining cycle duration
- **Program finished notification** -- occupancy sensor triggers when a cycle completes (use for automations)
- **Pushcut integration** -- optional webhook to trigger Shortcuts/Intercom announcements when a cycle finishes
- **Remote start/stop** -- optionally start and stop programs from HomeKit (disabled by default for safety)

## Supported Appliances

- Washing Machines (WM)
- Washer-Dryers (WD)
- Tumble Dryers (TD)

Any appliance connected to the Candy/Hoover/Haier hOn app should work. Tested with the Candy BC4SD496M6DB8-80.

## HomeKit Services

| Service | Purpose |
|---------|---------|
| **Valve** | Main status -- Active when running, InUse during cycle, RemainingDuration countdown |
| **Occupancy Sensor** | "Program Finished" -- triggers for 10 minutes when a cycle completes |

## Installation

### Via Homebridge UI (recommended)

Search for `homebridge-candy-hon` in the Homebridge plugin search.

### Via CLI

```bash
npm install -g homebridge-candy-hon
```

## Configuration

Add to your Homebridge `config.json` or use the settings UI:

```json
{
    "platform": "CandyHon",
    "name": "Candy hOn",
    "email": "your-hon-email@example.com",
    "password": "your-hon-password",
    "pollInterval": 60,
    "enableRemoteStart": false,
    "pushcutWebhookUrl": ""
}
```

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `email` | Yes | | Your hOn app email address |
| `password` | Yes | | Your hOn app password |
| `pollInterval` | No | 60 | Status poll interval in seconds (min 30) |
| `enableRemoteStart` | No | false | Allow starting/stopping programs from HomeKit |
| `pushcutWebhookUrl` | No | | Pushcut notification URL for cycle-complete announcements |

### Apple Sign-In Users

If you log into the hOn app via Apple Sign-In, you may need to set an email/password on your account. Check your hOn app profile for the account email, then use "Forgot Password" to set one.

### Pushcut Integration

To get HomePod announcements when a cycle finishes:

1. Install [Pushcut](https://www.pushcut.io/) on your iPhone
2. Create a notification with a "Run Shortcut" action pointing to your announcement shortcut
3. Copy the webhook URL and paste it into the plugin config
4. When a cycle finishes, Pushcut sends a notification -- tap it to trigger the announcement

## How It Works

The plugin authenticates with the hOn cloud platform using the same Salesforce OAuth flow as the mobile app, then polls the REST API for appliance status. No local network access to the machine is required -- it works entirely through the cloud.

## Machine Mode Reference

| Mode | State |
|------|-------|
| 0 | Idle (off) |
| 1 | Idle (standby, program selected) |
| 2 | Running |
| 3 | Paused |
| 4 | Delayed start |
| 5 | Finished |
| 6 | Error |
| 7 | Finished (cycle complete) |

## Known Limitations

- **Door status** is not available from the REST API for all models. The door sensor is not exposed.
- **Program selection** from HomeKit is not yet supported. Remote start triggers whatever program is currently selected on the machine's physical dial.
- **Polling delay** -- status updates every 60 seconds (configurable). Real-time MQTT updates are planned for a future release.
- **Auth flakiness** -- the hOn OAuth flow occasionally fails with "Re-authorize did not return tokens". The plugin will retry on the next poll cycle.

## Credits

- [Andre0512/pyhOn](https://github.com/Andre0512/pyhOn) -- the reverse-engineered hOn API that made this possible
- [Andre0512/hon](https://github.com/Andre0512/hon) -- the Home Assistant integration that proved the approach

## License

MIT
