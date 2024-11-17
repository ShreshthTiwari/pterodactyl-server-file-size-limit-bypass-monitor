const fs = require("node:fs/promises");
const path = require("node:path");
const NodeCache = require("node-cache");
const axios = require("axios");
const { execSync } = require("child_process");

const config = require("./config/config.json");

if (
  !(
    config.panel_url.startsWith("http://") ||
    config.panel_url.startsWith("https://")
  )
) {
  config.panel_url = "http://" + config.panel_url;
}

if (config.panel_url.endsWith("/")) {
  config.panel_url = config.panel_url.slice(0, -1);
}

const cache = new NodeCache({
  stdTTL: 60 * 60 * 24,
});
const cumulativeChanges = new NodeCache({
  stdTTL: config.cumulative_change_cache_time_in_seconds,
});
const serversCache = new NodeCache({
  stdTTL: config.servers_list_cache_time_in_seconds,
});

const volumesPath = path.join(config.containers_directory);

const listDirectoriesAsync = async (basePath) => {
  try {
    const items = await fs.readdir(basePath, { withFileTypes: true });
    return items.filter((item) => item.isDirectory()).map((item) => item.name);
  } catch (err) {
    console.error(`[${time()}] Error reading directory:`, err.message);
    return [];
  }
};

const fetchVolumeSize = async (volumePath) => {
  try {
    const output = execSync(`du -sb "${volumePath}"`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    const sizeInBytes = parseInt(output.split("\t")[0]);
    return convertToGB(sizeInBytes);
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      console.error(
        `[${time()}] Timeout while fetching volume size for ${volumePath}`
      );
    } else {
      console.error(`[${time()}] Error fetching volume size:`, err.message);
    }
    return 0;
  }
};

const convertToGB = (bytes) => {
  return bytes / (1024 * 1024 * 1024);
};

const cacheInternalIDs = async (volumes) => {
  try {
    let serversListData = serversCache.get("servers_list");

    if (!serversListData) {
      console.log(`[${time()}] Fetching fresh servers list from API...`);
      const response = await axios.get(
        `${config.panel_url}/api/application/servers`,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.admin_api_key}`,
          },
          timeout: 5000,
        }
      );

      serversListData = response.data;

      serversCache.set("servers_list", serversListData);
    }

    if (serversListData?.data) {
      const volumeSizePromises = volumes.map(async (volume) => {
        const volumePath = path.join(volumesPath, volume);
        const volumeSize = await fetchVolumeSize(volumePath);
        return { volume, volumeSize };
      });

      const volumeSizes = await Promise.all(volumeSizePromises);

      for (const { volume, volumeSize } of volumeSizes) {
        const server = serversListData.data.find(
          (s) => s.attributes?.uuid === volume
        );
        if (server) {
          cache.set(volume, {
            internal_id: server.attributes.id,
            size: volumeSize,
            max_size: server.attributes.limits.disk / 1024,
          });
        } else {
          console.log(
            `[${time()}] No matching server found for volume ${volume}`
          );
        }
      }
    }
  } catch (err) {
    console.error(`[${time()}] Error assigning internal IDs:`, err.message);
  }
};

const time = () => {
  return new Date().toLocaleTimeString();
};

const sendDiscordNotification = async (volume, reason, details) => {
  if (!config.discord_webhook_url) return;

  try {
    const embed = {
      title: "⚠️ Volume Abuse Detection",
      color: 0xff0000,
      fields: [
        {
          name: "Volume",
          value: volume,
          inline: true,
        },
        {
          name: "Reason",
          value: reason,
          inline: true,
        },
        {
          name: "Details",
          value: details,
        },
      ],
      timestamp: new Date().toISOString(),
    };

    await axios.post(config.discord_webhook_url, {
      embeds: [embed],
    });
  } catch (err) {
    console.error(
      `[${time()}] Error sending Discord notification:`,
      err.message
    );
  }
};

const main = async () => {
  const volumes = await listDirectoriesAsync(volumesPath);

  console.log(`[${time()}] Buffering up cache with internal IDs...`);

  await cacheInternalIDs(volumes);

  console.log(`[${time()}] Cache populated with internal IDs.`);

  if (volumes?.length >= 1) {
    for (const volume of volumes) {
      const volumePath = path.join(volumesPath, volume);

      let cachedVolumeData = cache.get(volume) ?? { internal_id: 0, size: 0 };
      const volumeSize = await fetchVolumeSize(volumePath);

      let cumulativeChange = parseFloat(cumulativeChanges.get(volume) ?? "0");

      if (volumeSize > cachedVolumeData.size) {
        cumulativeChange += volumeSize - cachedVolumeData.size;
      }

      if (
        volumeSize - cachedVolumeData.size >=
          config.check_interval_threshold_in_gb ||
        cumulativeChange >= config.cumulative_change_threshold_in_gb ||
        (cachedVolumeData.max_size > 0 &&
          volumeSize * 1024 > cachedVolumeData.max_size)
      ) {
        if (
          volumeSize - cachedVolumeData.size >=
          config.check_interval_threshold_in_gb
        ) {
          const message = `Volume "${volume}" changed by ${(
            volumeSize - cachedVolumeData.size
          ).toFixed(2)}GB (cumulative: ${cumulativeChange.toFixed(
            2
          )}GB).\nAbove abuse threshold.\nSuspending volume...`;
          console.log(`[${time()}] ${message}`);

          await sendDiscordNotification(
            volume,
            "Sudden Size Increase",
            `Volume size increased by ${(
              volumeSize - cachedVolumeData.size
            ).toFixed(2)}GB\nCumulative change: ${cumulativeChange.toFixed(
              2
            )}GB`
          );
        } else if (
          cumulativeChange >= config.cumulative_change_threshold_in_gb
        ) {
          const message = `Volume "${volume}" has accumulated ${cumulativeChange.toFixed(
            2
          )}GB of changes.\nSuspective abuse detected.\nSuspending volume...`;
          console.log(`[${time()}] ${message}`);

          await sendDiscordNotification(
            volume,
            "Cumulative Size Increase",
            `Total accumulated changes: ${cumulativeChange.toFixed(2)}GB`
          );
        } else if (
          cachedVolumeData.max_size > 0 &&
          volumeSize * 1024 > cachedVolumeData.max_size
        ) {
          const message = `Volume "${volume}" has surpassed its maximum storage limit.\nSuspending volume...`;
          console.log(`[${time()}] ${message}`);

          await sendDiscordNotification(
            volume,
            "Storage Limit Exceeded",
            `Current size: ${volumeSize.toFixed(2)}GB\nMax allowed: ${(
              cachedVolumeData.max_size / 1024
            ).toFixed(2)}GB`
          );
        }

        if (cachedVolumeData?.internal_id > 0) {
          try {
            await axios.post(
              `${config.panel_url}/api/application/servers/${cachedVolumeData.internal_id}/suspend`,
              {
                suspended: true,
              },
              {
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${config.admin_api_key}`,
                },
                timeout: 5000,
              }
            );

            console.log(`[${time()}] Volume "${volume}" suspended.`);
            cumulativeChanges.set(volume, "0");
          } catch (err) {
            console.error(
              `[${time()}] Error suspending volume "${volume}":`,
              err.message
            );
          }
        } else {
          console.log(
            `[${time()}] Error suspending volume "${volume}": Internal ID not found`
          );
        }
      } else {
        console.log(
          `[${time()}] Volume "${volume}" changed by ${(
            volumeSize - cachedVolumeData.size
          ).toFixed(2)}GB (cumulative: ${cumulativeChange.toFixed(
            2
          )}GB).\nBelow abuse threshold.\nSkipping...`
        );

        cache.set(volume, {
          internal_id: cachedVolumeData.internal_id,
          size: volumeSize,
        });

        cumulativeChanges.set(volume, cumulativeChange.toString());
      }
    }
  } else {
    console.log(`[${time()}] No volumes found`);
  }
};

setInterval(async () => {
  await main();
}, config.check_interval_in_seconds * 1000);
