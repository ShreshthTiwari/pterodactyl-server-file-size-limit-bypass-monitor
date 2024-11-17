# Pterodactyl Server File Size Monitor

A monitoring bot designed to detect and prevent potential file size abuse in Pterodactyl panel servers by tracking file size changes and alerting administrators of suspicious activities.

## Features

- Monitors server container directories for file size changes
- Tracks both instant and cumulative file size changes
- Alerts through Discord webhooks when suspicious changes are detected
- Configurable thresholds and monitoring intervals
- Server list caching for improved performance

## Prerequisites

- Node.js (v14 or higher)
- Access to Pterodactyl Panel with Admin API key
- Discord webhook for notifications
- Access to Pterodactyl container volumes directory

## Installation

1. Clone this repository:

```bash
git clone https://github.com/ShreshthTiwari/pterodactyl-server-file-size-limit-bypass-monitor.git
cd pterodactyl-server-file-size-limit-bypass-monitor
```

2. Install dependencies:

```bash
npm install
```

3. Configure your `src/config/config.json` file (see Configuration section below)

4. Start the bot:

```bash
npm start
```

## Configuration

Create or modify the `src/config/config.json` file with the following structure:

```json
{
  "containers_directory": "/var/lib/pterodactyl/volumes/",
  "panel_url": "",
  "admin_api_key": "",
  "check_interval_in_seconds": 1,
  "check_interval_threshold_in_gb": 1,
  "servers_list_cache_time_in_seconds": 60,
  "cumulative_change_cache_time_in_seconds": 300,
  "cumulative_change_threshold_in_gb": 5,
  "discord_webhook_url": ""
}
```

### Configuration Parameters

- `containers_directory`: Path to Pterodactyl server volumes directory
- `panel_url`: Your Pterodactyl panel URL (e.g., "https://panel.yourdomain.com")
- `admin_api_key`: Your Pterodactyl panel Admin API key
- `check_interval_in_seconds`: How often to check for file size changes (in seconds)
- `check_interval_threshold_in_gb`: Maximum allowed file size increase per check interval (in GB)
- `servers_list_cache_time_in_seconds`: How long to cache the server list (in seconds)
- `cumulative_change_cache_time_in_seconds`: Time window for tracking cumulative changes (in seconds)
- `cumulative_change_threshold_in_gb`: Maximum allowed cumulative file size increase (in GB)
- `discord_webhook_url`: Discord webhook URL for notifications

## How It Works

1. The bot periodically checks the size of files in each server's container directory
2. It tracks two types of changes:
   - Instant changes: File size increases that exceed `check_interval_threshold_in_gb` within one check interval
   - Cumulative changes: Total file size increases that exceed `cumulative_change_threshold_in_gb` within the cumulative change time window
3. When suspicious changes are detected, it sends alerts via Discord webhook

## Security Considerations

- Store your config.json in a secure location
- Use a dedicated Admin API key with appropriate permissions
- Regularly review Discord notifications and logs
- Ensure the bot has proper read permissions for the containers directory

## Troubleshooting

Common issues and solutions:

1. **No Discord notifications:**

   - Verify your webhook URL is correct
   - Check if the bot has internet access

2. **Can't access container directory:**

   - Ensure the bot has proper permissions
   - Verify the containers_directory path is correct

3. **High CPU usage:**
   - Increase the check_interval_in_seconds
   - Adjust the servers_list_cache_time_in_seconds

## Contributing

Feel free to submit issues and pull requests to help improve this tool.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
