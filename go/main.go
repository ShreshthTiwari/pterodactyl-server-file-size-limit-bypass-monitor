package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ContainersDirectory string `json:"containers_directory"`
	PanelURL           string `json:"panel_url"`
	AdminAPIKey        string `json:"admin_api_key"`
	ClientAPIKey       string `json:"client_api_key"`
	CheckInterval      int    `json:"check_interval_in_seconds"`
	DiscordWebhookURL  string `json:"discord_webhook_url"`
}

type Server struct {
	ID     string `json:"identifier"`
	UUID   string `json:"uuid"`
	Limits struct {
		Disk int `json:"disk"`
	} `json:"limits"`
}

type DiscordMessage struct {
	Content string `json:"content"`
}

func loadConfig() Config {
	data, err := os.ReadFile("config/config.json")
	if err != nil {
		log.Fatal("Error reading config:", err)
	}

	var config Config
	err = json.Unmarshal(data, &config)
	if err != nil {
		log.Fatal("Error parsing config:", err)
	}

	// Normalize panel URL
	if !strings.HasPrefix(config.PanelURL, "http://") && !strings.HasPrefix(config.PanelURL, "https://") {
		config.PanelURL = "http://" + config.PanelURL
	}
	config.PanelURL = strings.TrimSuffix(config.PanelURL, "/")

	return config
}

func getDiskUsage(path string) (int64, error) {
	cmd := exec.Command("du", "-sb", path)
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	parts := strings.Fields(string(output))
	if len(parts) < 1 {
		return 0, fmt.Errorf("unexpected du output format")
	}

	size, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, err
	}

	return size, nil
}

func sendDiscordNotification(webhookURL, volume, reason, details string) error {
	if webhookURL == "" {
		return nil
	}

	message := DiscordMessage{
		Content: fmt.Sprintf("🚨 Alert for volume %s\nReason: %s\nDetails: %s\nTime: %s",
			volume, reason, details, time.Now().Format("2006-01-02 15:04:05")),
	}

	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}

	resp, err := http.Post(webhookURL, "application/json", bytes.NewBuffer(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("discord webhook returned status: %d", resp.StatusCode)
	}

	return nil
}

// time returns the current time in the same format as the JavaScript version
func timeStr() string {
	return time.Now().Format("15:04:05")
}

func main() {
	config := loadConfig()
	log.Printf("[%s] Starting Pterodactyl disk monitor...", timeStr())
	log.Printf("[%s] Checking directory: %s", timeStr(), config.ContainersDirectory)

	ticker := time.NewTicker(time.Duration(config.CheckInterval) * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		files, err := os.ReadDir(config.ContainersDirectory)
		if err != nil {
			log.Printf("[%s] Error reading directory: %v", timeStr(), err)
			continue
		}

		for _, file := range files {
			if !file.IsDir() || file.Name() == ".sftp" {
				continue
			}

			volumePath := filepath.Join(config.ContainersDirectory, file.Name())
			usage, err := getDiskUsage(volumePath)
			if err != nil {
				log.Printf("[%s] Error getting disk usage for %s: %v", timeStr(), file.Name(), err)
				continue
			}

			usageGB := float64(usage) / (1024 * 1024 * 1024)
			log.Printf("[%s] Volume %s: %.2f GB", timeStr(), file.Name(), usageGB)

			// If usage is too high, send notification
			if usageGB > 95 { // Example threshold of 95GB
				err = sendDiscordNotification(
					config.DiscordWebhookURL,
					file.Name(),
					"High disk usage",
					fmt.Sprintf("Current usage: %.2f GB", usageGB),
				)
				if err != nil {
					log.Printf("[%s] Error sending notification: %v", timeStr(), err)
				}
			}
		}
	}
}
