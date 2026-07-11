#pragma once

#include "config.h"

// Called after a valid {"cmd":"provision", ...} line was saved to NVS.
typedef void (*ProvisionedCallback)(const DeviceConfig &config);

// Poll the USB serial for one-line JSON commands (provision/status/clear).
// Active in every state so a device can be re-provisioned without reflashing.
void provisioningPoll(const DeviceConfig &current, ProvisionedCallback onProvisioned);
