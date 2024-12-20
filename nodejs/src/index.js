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
const serversCache = new NodeCache({
  stdTTL: config.servers_list_cache_time_in_seconds,
});

const volumesPath = path.join(config.containers_directory);

const listDirectoriesAsync = async (basePath) => {
  try {
    const items = await fs.readdir(basePath, { withFileTypes: true });
    return items
      .filter((item) => item.isDirectory() && item.name !== ".sftp")
      .map((item) => item.name);
  } catch (err) {
    console.error(`[${time()}] Error reading directory:`, err.message);
    return [];
  }
};

const fetchVolumeSize = async (volumePath) => {
  try {
    const output = execSync(
      `find "${volumePath}" -type f -exec stat --format=%s {} + 2>/dev/null | awk 'BEGIN{total=0} {total += $1} END{print total}'`,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 10000,
      }
    );

    const blockOutput = execSync(
      `find "${volumePath}" -type f -exec stat --format=%b {} + 2>/dev/null | awk 'BEGIN{total=0} {total += $1} END{print total}'`,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 10000,
      }
    );

    const sizeInBytes = parseInt(output.trim()) || 0;
    const blockSize = (parseInt(blockOutput.trim()) || 0) * 512;

    const actualSize = Math.max(sizeInBytes, blockSize);
    const sizeInGB = convertToGB(actualSize);

    return sizeInGB;
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

const emptyVolume = async (volume, volumePath) => {
  console.log(`[${time()}] Emptying volume "${volume}"...`);

  try {
    execSync(`find "${volumePath}" -mindepth 1 -delete`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 10000,
    });

    execSync(
      `rm -rf "${volumePath}"/* "${volumePath}"/.[!.]* "${volumePath}"/..?* 2>/dev/null || true`,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 10000,
      }
    );

    console.log(`[${time()}] Volume "${volume}" emptied successfully.`);
  } catch (err) {
    console.error(`[${time()}] Error emptying volume:`, err.message);
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
      for (const volume of volumes) {
        const server = serversListData.data.find(
          (server) => server.attributes.uuid === volume
        );

        if (server) {
          cache.set(volume, {
            internal_id: server.attributes.id,
            max_size: server.attributes.limits.disk / 1024,
            name: server.attributes.name,
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

const sendDiscordNotification = async (
  volume,
  volumeName,
  reason,
  details,
  result
) => {
  if (!config.discord_webhook_url) return;

  try {
    const embed = {
      title: "⚠️ Volume Abuse Detection",
      color: 0xff0000,
      fields: [
        {
          name: "Volume",
          value: "```fix\n" + `${volume}` + "\n```",
        },
        {
          name: "Name",
          value: "```fix\n" + `${volumeName}` + "\n```",
        },
        {
          name: "Reason",
          value: "```fix\n" + `${reason}` + "\n```",
        },
        {
          name: "Details",
          value: "```fix\n" + `${details}` + "\n```",
        },
        {
          name: "Action Taken",
          value: "```fix\n" + `${result}` + "\n```",
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

      let cachedVolumeData = cache.get(volume) ?? {
        internal_id: 0,
        max_size: 0,
        name: "",
      };
      const volumeSize = await fetchVolumeSize(volumePath);
      const volumeName = cachedVolumeData.name;

      if (
        cachedVolumeData.max_size > 0 &&
        volumeSize > cachedVolumeData.max_size / 10 + cachedVolumeData.max_size
      ) {
        console.log(
          `[${time()}] Volume "${volume}" "${volumeSize.toFixed(
            2
          )}GB" has surpassed its maximum storage limit "${cachedVolumeData.max_size.toFixed(
            2
          )}GB".\nSuspending volume...`
        );

        if (cachedVolumeData?.internal_id > 0) {
          try {
            await axios.post(
              `${config.panel_url}/api/client/servers/${
                volume.split("-")[0]
              }/power`,
              {
                signal: "kill",
              },
              {
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${config.client_api_key}`,
                },
              }
            );
          } catch (err) {
            console.error(
              `[${time()}] Error killing volume "${volume}":`,
              err.message
            );
          }

          await emptyVolume(volume, volumePath);

          setTimeout(async () => {
            try {
              await axios.post(
                `${config.panel_url}/api/application/servers/${cachedVolumeData.internal_id}/suspend`,
                {},
                {
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.admin_api_key}`,
                  },
                }
              );

              console.log(`[${time()}] Volume "${volume}" suspended.`);
            } catch (err) {
              console.error(
                `[${time()}] Error suspending volume "${volume}":`,
                err.message
              );
            }

            await emptyVolume(volume, volumePath);

            await sendDiscordNotification(
              volume,
              volumeName,
              "Storage Limit Exceeded",
              `Current size: ${volumeSize.toFixed(
                2
              )}GB\nMax allowed: ${cachedVolumeData.max_size.toFixed(2)}GB`,
              "All files have been deleted.\nVolume has been suspended."
            );
          }, 1 * 1000);
        } else {
          console.log(
            `[${time()}] Error suspending volume "${volume}": Internal ID not found`
          );
        }
      } else {
        console.log(
          `[${time()}] Volume "${volume}" size "${volumeSize.toFixed(
            2
          )}GB" is below maximum storage limit "${cachedVolumeData.max_size.toFixed(
            2
          )}GB".\nBelow abuse threshold.\nSkipping...`
        );
      }
    }
  } else {
    console.log(`[${time()}] No volumes found`);
  }
};

setInterval(async () => {
  await main();
}, config.check_interval_in_seconds * 1000);
