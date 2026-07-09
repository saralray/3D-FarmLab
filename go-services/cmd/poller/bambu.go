package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// ── Persistent MQTT-over-TLS client, one per Bambu printer ───────────────────

type bambuClient struct {
	host, accessCode, serial  string
	reportTopic, requestTopic string
	mu                        sync.Mutex
	print                     pmap
	lastReport                time.Time
	lastPushall               time.Time
	client                    mqtt.Client
}

func newBambuClient(host, accessCode, serial string) *bambuClient {
	c := &bambuClient{
		host:         host,
		accessCode:   accessCode,
		serial:       serial,
		reportTopic:  fmt.Sprintf("device/%s/report", serial),
		requestTopic: fmt.Sprintf("device/%s/request", serial),
		print:        pmap{},
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(fmt.Sprintf("ssl://%s:%d", host, bambuMqttPort))
	opts.SetUsername(bambuMqttUsername)
	opts.SetPassword(accessCode)
	opts.SetTLSConfig(bambuTLSConfig()) // H-2: see util.go bambuTLSConfig
	opts.SetClientID(fmt.Sprintf("printfarm-poller-%s-%d", serial, time.Now().UnixNano()))
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(time.Second)
	opts.SetMaxReconnectInterval(30 * time.Second)
	opts.SetKeepAlive(30 * time.Second)
	opts.SetOnConnectHandler(c.onConnect)
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		// AutoReconnect handles the reconnect; just note it for diagnostics.
		log.Printf("bambu mqtt connection lost (%s): %v", host, err)
	})

	c.client = mqtt.NewClient(opts)
	c.client.Connect() // async; ConnectRetry keeps trying until reachable
	return c
}

func (c *bambuClient) onConnect(client mqtt.Client) {
	token := client.Subscribe(c.reportTopic, 0, c.onMessage)
	go func() {
		token.Wait()
		if err := token.Error(); err != nil {
			log.Printf("bambu mqtt subscribe failed (%s): %v", c.host, err)
			return
		}
		c.mu.Lock()
		c.lastPushall = time.Time{}
		c.mu.Unlock()
		c.requestPushall()
	}()
}

func (c *bambuClient) onMessage(_ mqtt.Client, msg mqtt.Message) {
	// Count the message as received regardless of whether it parses — the
	// bytes still arrived over the wire.
	addBytesIn(len(msg.Payload()))
	var payload pmap
	if err := json.Unmarshal(msg.Payload(), &payload); err != nil {
		return
	}
	printData := asMap(payload["print"])
	if printData == nil {
		return
	}
	c.mu.Lock()
	for k, v := range printData {
		c.print[k] = v
	}
	c.lastReport = time.Now()
	c.mu.Unlock()
}

func (c *bambuClient) requestPushall() {
	now := time.Now()
	c.mu.Lock()
	if !c.lastPushall.IsZero() && now.Sub(c.lastPushall) < bambuPushallMinInterval {
		c.mu.Unlock()
		return
	}
	c.lastPushall = now
	c.mu.Unlock()
	const pushallPayload = `{"pushing": {"sequence_id": "0", "command": "pushall"}}`
	addBytesOut(len(pushallPayload))
	c.client.Publish(c.requestTopic, 0, false, pushallPayload)
}

// latestReport returns the cached report, nudging a pushall when stale, or nil
// when no fresh report is available (the caller applies the offline grace period).
func (c *bambuClient) latestReport() pmap {
	c.mu.Lock()
	var data pmap
	var age time.Duration
	if len(c.print) > 0 {
		data = clone(c.print)
		age = time.Since(c.lastReport)
	} else {
		age = time.Duration(1 << 62)
	}
	c.mu.Unlock()

	if data == nil || age > bambuReportFreshness/2 {
		c.requestPushall()
	}
	if data == nil || age > bambuReportFreshness {
		return nil
	}
	return data
}

func (c *bambuClient) close() {
	if c.client != nil {
		c.client.Disconnect(250)
	}
}

var (
	bambuClients   = map[string]*bambuClient{}
	bambuClientsMu sync.Mutex
)

func getBambuClient(printer pmap) *bambuClient {
	id := mStr(printer, "id")
	host := mStr(printer, "ipAddress")
	access := strings.TrimSpace(mStr(printer, "apiKeyHeader"))
	serial := strings.TrimSpace(mStr(printer, "serial"))

	bambuClientsMu.Lock()
	defer bambuClientsMu.Unlock()
	c := bambuClients[id]
	if c != nil && (c.host != host || c.accessCode != access || c.serial != serial) {
		c.close()
		c = nil
	}
	if c == nil {
		c = newBambuClient(host, access, serial)
		bambuClients[id] = c
	}
	return c
}

// pruneBambuClients drops MQTT connections (and 3MF attempt records) for printers
// that no longer exist.
func pruneBambuClients(activeIDs map[string]bool) {
	bambuClientsMu.Lock()
	for id, c := range bambuClients {
		if !activeIDs[id] {
			c.close()
			delete(bambuClients, id)
		}
	}
	bambuClientsMu.Unlock()

	for key := range bambu3mfAttempts {
		if !activeIDs[key.printerID] {
			delete(bambu3mfAttempts, key)
		}
	}
}

func mapBambuState(state any) string {
	s, ok := state.(string)
	if !ok {
		return "idle"
	}
	if mapped, ok := bambuStateMap[strings.ToUpper(s)]; ok {
		return mapped
	}
	return "idle"
}

func buildBambuCurrentJob(printData, previousJob pmap, progress int, status string, remainingMinutes int) pmap {
	if status != "printing" && status != "paused" {
		return nil
	}
	filename := mStr(printData, "subtask_name")
	if filename == "" {
		filename = mStr(printData, "gcode_file")
	}
	if filename == "" {
		return nil
	}

	var startTime string
	if previousJob != nil && mStr(previousJob, "filename") == filename {
		startTime = mStr(previousJob, "startTime")
	} else {
		startTime = isoTimestamp()
	}

	printingTimeMinutes := 0.0
	if startedEpoch, ok := parseISOEpoch(startTime); ok {
		printingTimeMinutes = maxF(0, round((float64(time.Now().Unix())-float64(startedEpoch))/60))
	}
	estimatedTimeMinutes := 0.0
	if remainingMinutes != 0 {
		estimatedTimeMinutes = printingTimeMinutes + float64(remainingMinutes)
	}

	jobStatus := "printing"
	if status == "paused" {
		jobStatus = "paused"
	}
	return pmap{
		"id":            "job-" + filename,
		"filename":      filename,
		"status":        jobStatus,
		"progress":      float64(progress),
		"estimatedTime": estimatedTimeMinutes,
		"timeRemaining": float64(remainingMinutes),
		"printingTime":  printingTimeMinutes,
		"filamentUsed":  float64(0),
		"startTime":     startTime,
		"priority":      "medium",
	}
}

func buildBambuSpools(printData pmap) any {
	var spools []any
	addTray := func(tray any, slotID string) {
		t := asMap(tray)
		if t == nil {
			return
		}
		material := mStr(t, "tray_type")
		tagUID := strings.TrimSpace(mStr(t, "tag_uid"))
		trayUUID := strings.TrimSpace(mStr(t, "tray_uuid"))
		// A third-party/unrecognized tag the AMS can't decode as Bambu format
		// reports empty tray_type but may still carry a raw tag_uid from the
		// anti-collision phase — needed for filament_matcher.go's auto-catalog/
		// auto-assign (plan §3a) to ever see it. Only skip when there's truly
		// nothing to report (no material and no tag identifier at all).
		if material == "" && tagUID == "" && trayUUID == "" {
			return
		}
		colorRaw := "808080FF"
		if c := fmt.Sprintf("%v", t["tray_color"]); c != "" && t["tray_color"] != nil {
			colorRaw = c
		}
		color := firstN(colorRaw, 6)
		vendor := strings.TrimSpace(mStr(t, "tray_id_name"))
		remainVal, remainOK := mFloat(t, "remain")
		remainValid := remainOK && remainVal >= 0
		remaining := 0
		if remainValid {
			remaining = clampInt(round(remainVal), 0, 100)
		}
		fullWeight := 0.0
		if fw, ok := mFloat(t, "tray_weight"); ok {
			fullWeight = fw
		}
		weight := 0.0
		if remainValid && fullWeight > 0 {
			weight = round1(fullWeight * float64(remaining) / 100)
		}
		// tray_uuid/tag_uid: the AMS's own RFID reader already read these off a
		// genuine Bambu tag over MQTT — this is the "filament reader" data
		// filament_matcher.go uses to auto-catalog the spool into
		// filament_spools (plan §3a), same fields Bambuddy's
		// spool_tag_matcher.py keys on. Additive: existing consumers of
		// "spools" only read the keys they already expect.
		spools = append(spools, pmap{
			"id":            slotID,
			"color":         "#" + color,
			"material":      material,
			"vendor":        vendor,
			"remaining":     float64(remaining),
			"weight":        weight,
			"traySubBrands": strings.TrimSpace(mStr(t, "tray_sub_brands")),
			"trayUuid":      trayUUID,
			"tagUid":        tagUID,
			"nozzleTempMin": mInt(t, "nozzle_temp_min"),
			"nozzleTempMax": mInt(t, "nozzle_temp_max"),
			"trayWeight":    fullWeight,
		})
	}

	amsRoot := asMap(printData["ams"])
	if amsRoot != nil {
		for _, unitAny := range mSlice(amsRoot, "ams") {
			unit := asMap(unitAny)
			if unit == nil {
				continue
			}
			unitID := "0"
			if v, ok := unit["id"]; ok {
				unitID = fmt.Sprintf("%v", v)
			}
			for _, trayAny := range mSlice(unit, "tray") {
				tray := asMap(trayAny)
				var trayID any
				if tray != nil {
					trayID = tray["id"]
				}
				addTray(trayAny, fmt.Sprintf("ams%s-%v", unitID, trayID))
			}
		}
	}
	addTray(printData["vt_tray"], "external")

	if len(spools) == 0 {
		return nil
	}
	return spools
}

func bambuActiveSpoolID(printData pmap) any {
	amsRoot := asMap(printData["ams"])
	if amsRoot == nil {
		if asMap(printData["vt_tray"]) != nil {
			return "external"
		}
		return nil
	}
	trayNowStr := strings.TrimSpace(fmt.Sprintf("%v", amsRoot["tray_now"]))
	globalIndex, err := strconv.Atoi(trayNowStr)
	if err != nil {
		return nil
	}
	if globalIndex >= 254 {
		if asMap(printData["vt_tray"]) != nil {
			return "external"
		}
		return nil
	}
	if globalIndex < 0 {
		return nil
	}
	return fmt.Sprintf("ams%d-%d", globalIndex/4, globalIndex%4)
}

// bambuTrayKey is the (ams_id, tray_id) addressing scheme filament_station_assignments
// uses, matching the ams_id=255/tray_id=254 convention already used by
// bambuCommands.js's set_filament handler for the external spool.
func bambuTrayKey(amsID, trayID int) string {
	return fmt.Sprintf("%d:%d", amsID, trayID)
}

// rawBambuTrays returns every AMS tray keyed by "ams_id:tray_id" — including
// empty ones (no material) — for the deferred-assignment replay detector
// (assignments.go). Independent of buildBambuSpools's flattened, "material
// required" projection used for printers.spools JSONB: replay detection needs
// to see an empty tray's raw state (state/tray_uuid/tray_type), which
// buildBambuSpools skips entirely. Re-reads the same in-memory cached MQTT
// report buildBambuSpools/fetchBambuStatus already used this cycle — cheap,
// not a second poll (see bambuClient.latestReport).
func rawBambuTrays(printer pmap) map[string]pmap {
	client := getBambuClient(printer)
	printData := client.latestReport()
	if printData == nil {
		return nil
	}

	out := map[string]pmap{}
	amsRoot := asMap(printData["ams"])
	if amsRoot != nil {
		for _, unitAny := range mSlice(amsRoot, "ams") {
			unit := asMap(unitAny)
			if unit == nil {
				continue
			}
			unitID := mInt(unit, "id")
			for _, trayAny := range mSlice(unit, "tray") {
				tray := asMap(trayAny)
				if tray == nil {
					continue
				}
				trayID := mInt(tray, "id")
				out[bambuTrayKey(unitID, trayID)] = tray
			}
		}
	}
	if vt := asMap(printData["vt_tray"]); vt != nil {
		out[bambuTrayKey(255, 254)] = vt
	}
	return out
}

// ── filament-used AMS delta baseline ────────────────────────────────────────

// baselineState is a print-start snapshot: AMS-delta baseline grams (for the
// remain%-delta fallback) plus everything filament_consumption.go's
// resolveSlotToTray needs to map 3MF filament slots back to physical trays
// after the print ends — mirrors Bambuddy's usage_tracker.PrintSession,
// captured once at print start rather than re-derived from (possibly stale
// or already-overwritten-by-the-next-job) MQTT state at completion time.
type baselineState struct {
	filename      string
	grams         map[string]float64 // slot key -> grams remaining, at print start
	mqttMapping   []any              // raw printData["mapping"], at print start
	trayColor     map[string]string  // slot key -> "#rrggbb", at print start
	trayType      map[string]string  // slot key -> tray_type, at print start (empty = unloaded)
	activeTrayKey string             // bambuActiveSpoolID(printData) at print start
	startedAt     time.Time
}

var (
	bambuPrintBaseline   = map[string]*baselineState{}
	bambuPrintBaselineMu sync.Mutex
)

func spoolGrams(spools any) map[string]float64 {
	out := map[string]float64{}
	for _, s := range asSlice(spools) {
		sp := asMap(s)
		if sp == nil {
			continue
		}
		id := mStr(sp, "id")
		w := mFloatDef(sp, "weight", 0)
		if id != "" && w > 0 {
			out[id] = w
		}
	}
	return out
}

// spoolColorsAndTypes mirrors spoolGrams but pulls the color/material fields
// buildBambuSpools also puts on each entry, needed for matchSlotsByColor and
// the position-based (loaded-slot) mapping fallback.
func spoolColorsAndTypes(spools any) (color, material map[string]string) {
	color = map[string]string{}
	material = map[string]string{}
	for _, s := range asSlice(spools) {
		sp := asMap(s)
		if sp == nil {
			continue
		}
		id := mStr(sp, "id")
		if id == "" {
			continue
		}
		if c := mStr(sp, "color"); c != "" {
			color[id] = c
		}
		if m := mStr(sp, "material"); m != "" {
			material[id] = m
		}
	}
	return color, material
}

// takeBambuPrintBaseline pops and returns the baseline for printerID, or nil
// if none is tracked. Ownership of clearing the baseline lives here (not in
// updateBambuFilamentUsed) so filament_consumption.go's finalize step can
// still read it after the job has already gone nil this same poll cycle —
// see run.go/filament_consumption.go for why that ordering matters.
func takeBambuPrintBaseline(printerID string) *baselineState {
	bambuPrintBaselineMu.Lock()
	defer bambuPrintBaselineMu.Unlock()
	state := bambuPrintBaseline[printerID]
	delete(bambuPrintBaseline, printerID)
	return state
}

func updateBambuFilamentUsed(printerID string, job pmap, spools any, mqttMapping []any, activeTrayKey string) {
	if printerID == "" {
		return
	}
	bambuPrintBaselineMu.Lock()
	defer bambuPrintBaselineMu.Unlock()

	if job == nil {
		// Leave any existing baseline in place — filament_consumption.go's
		// applyFilamentConsumption (run.go, after collectAnalyticsForTransition)
		// still needs it to resolve the print that just ended, and is
		// responsible for clearing it via takeBambuPrintBaseline once done.
		return
	}
	current := spoolGrams(spools)
	filename := mStr(job, "filename")
	state := bambuPrintBaseline[printerID]
	if state == nil || state.filename != filename {
		grams := make(map[string]float64, len(current))
		for k, v := range current {
			grams[k] = v
		}
		trayColor, trayType := spoolColorsAndTypes(spools)
		state = &baselineState{
			filename:      filename,
			grams:         grams,
			mqttMapping:   mqttMapping,
			trayColor:     trayColor,
			trayType:      trayType,
			activeTrayKey: activeTrayKey,
			startedAt:     time.Now(),
		}
		bambuPrintBaseline[printerID] = state
	} else {
		for id, g := range current {
			if _, ok := state.grams[id]; !ok {
				state.grams[id] = g
			}
		}
	}
	used := 0.0
	for id, g := range current {
		base, ok := state.grams[id]
		if !ok {
			base = g
		}
		used += maxF(0, base-g)
	}
	job["filamentUsed"] = round1(used)
}

// ── fan / chamber / nozzle decoders ──────────────────────────────────────────

var bambuFanFields = map[string]string{
	"part":    "cooling_fan_speed",
	"aux":     "big_fan1_speed",
	"chamber": "big_fan2_speed",
}

var bambuProfileFans = map[string][]string{
	"bambulab_a1_mini": {"part", "aux"},
	"bambulab_h2s":     {"part", "aux", "chamber"},
	"bambulab_h2d":     {"part", "aux", "chamber"},
	"bambulab_h2c":     {"part", "aux", "chamber"},
}

func intFromAny(v any) (int, bool) {
	switch t := v.(type) {
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		if f, ok := asFloat(v); ok {
			return int(f), true
		}
	}
	return 0, false
}

func buildBambuFanSpeeds(printData pmap, profile string) any {
	var fanSpeeds []any
	for _, fanID := range bambuProfileFans[profile] {
		raw := printData[bambuFanFields[fanID]]
		n, ok := intFromAny(raw)
		if !ok {
			continue
		}
		percent := clampInt(round(float64(n)/15*100), 0, 100)
		fanSpeeds = append(fanSpeeds, pmap{"id": fanID, "speed": float64(percent)})
	}
	if len(fanSpeeds) == 0 {
		return nil
	}
	return fanSpeeds
}

func decodeChamberValue(value any) (float64, bool) {
	v, ok := asFloat(value)
	if !ok {
		return 0, false
	}
	if v > -50 && v < 100 {
		return v, true
	}
	if v > 500 {
		current := int(v) % 65536
		if current > -50 && current < 100 {
			return float64(current), true
		}
	}
	return 0, false
}

func chamberTempCandidates(printData pmap) []any {
	candidates := []any{printData["chamber_temper"]}
	if ctc := asMap(printData["ctc"]); ctc != nil {
		if info := asMap(ctc["info"]); info != nil {
			candidates = append(candidates, info["temp"])
		}
	}
	if info := asMap(printData["info"]); info != nil {
		candidates = append(candidates, info["temp"])
	}
	return candidates
}

func decodeBambuChamberTemp(printData pmap) (float64, bool) {
	for _, v := range chamberTempCandidates(printData) {
		if decoded, ok := decodeChamberValue(v); ok {
			return decoded, true
		}
	}
	return 0, false
}

func decodeBambuChamberTarget(printData pmap) (float64, bool) {
	explicit := []any{printData["mc_target_cham"]}
	if ctc := asMap(printData["ctc"]); ctc != nil {
		if info := asMap(ctc["info"]); info != nil {
			explicit = append(explicit, info["target"])
		}
	}
	for _, v := range explicit {
		if f, ok := asFloat(v); ok && f >= 0 && f <= 60 {
			return f, true
		}
	}
	for _, v := range chamberTempCandidates(printData) {
		if f, ok := asFloat(v); ok && f > 500 {
			target := int(f) / 65536
			if target >= 0 && target <= 60 {
				return float64(target), true
			}
		}
	}
	return 0, false
}

func decodeNozzleValue(value any) (current, target *float64) {
	v, ok := asFloat(value)
	if !ok {
		return nil, nil
	}
	if v > 500 {
		cur := int(v) % 65536
		tgt := int(v) / 65536
		if cur > -50 && cur < 500 {
			f := float64(cur)
			current = &f
		}
		if tgt >= 0 && tgt < 500 {
			f := float64(tgt)
			target = &f
		}
		return current, target
	}
	if v > -50 && v < 500 {
		current = &v
		return current, nil
	}
	return nil, nil
}

func buildBambuDualNozzles(printData pmap, fallbackNozzle float64, fallbackTemps, fallbackTargets []any) ([]any, []any) {
	info := asSlice(mGet(asMap(mGet(asMap(printData["device"]), "extruder")), "info"))
	byID := map[int]pmap{}
	for _, entryAny := range info {
		entry := asMap(entryAny)
		if entry == nil {
			continue
		}
		if id, ok := mFloat(entry, "id"); ok {
			byID[int(id)] = entry
		}
	}

	temps := []any{}
	targets := []any{}
	for _, index := range []int{0, 1} {
		entry := byID[index]
		current, packedTarget := decodeNozzleValue(mGet(entry, "temp"))
		var target *float64
		if et, ok := mFloat(entry, "target"); ok && et >= 0 && et < 500 {
			target = &et
		} else {
			target = packedTarget
		}
		if current == nil {
			if index < len(fallbackTemps) {
				if f, ok := asFloat(fallbackTemps[index]); ok {
					current = &f
				}
			}
			if current == nil {
				f := fallbackNozzle
				current = &f
			}
		}
		if target == nil {
			if index < len(fallbackTargets) {
				if f, ok := asFloat(fallbackTargets[index]); ok {
					target = &f
				}
			}
			if target == nil {
				z := 0.0
				target = &z
			}
		}
		temps = append(temps, round(deref(current)))
		targets = append(targets, round(deref(target)))
	}

	if len(byID) == 0 {
		if legacy, ok := mFloat(printData, "nozzle_temper"); ok {
			temps[0] = round(legacy)
		}
		if legacyTarget, ok := mFloat(printData, "nozzle_target_temper"); ok {
			targets[0] = round(legacyTarget)
		}
	}
	return temps, targets
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// fetchBambuStatus assembles a Bambu printer's live state from its cached MQTT
// report. Returns errOffline when no fresh report is available.
func fetchBambuStatus(printer pmap) (pmap, error) {
	if strings.TrimSpace(mStr(printer, "serial")) == "" {
		return nil, fmt.Errorf("bambu printer is missing its serial number")
	}
	client := getBambuClient(printer)
	printData := client.latestReport()
	if printData == nil {
		return nil, errOffline
	}

	gcodeState := printData["gcode_state"]
	status := mapBambuState(gcodeState)

	tempMap := mMap(printer, "temperature")
	fallbackNozzle := mFloatDef(tempMap, "nozzle", 0)
	fallbackBed := mFloatDef(tempMap, "bed", 0)
	fallbackChamber := mFloatDef(tempMap, "chamber", 0)

	nozzleTemperature := fallbackNozzle
	if v, ok := mFloat(printData, "nozzle_temper"); ok {
		nozzleTemperature = round(v)
	}
	bedTemperature := fallbackBed
	if v, ok := mFloat(printData, "bed_temper"); ok {
		bedTemperature = round(v)
	}
	chamberTemperature := fallbackChamber
	if v, ok := decodeBambuChamberTemp(printData); ok {
		chamberTemperature = round(v)
	}
	// chamber_target: prefer an explicit value from the live report; otherwise
	// carry forward whatever's already stored. Confirmed live on an H2S that
	// this unit's firmware never reports an explicit chamber target field at
	// all (mc_target_cham / ctc.info.target always absent), so this fallback
	// is what's actually in effect for chamber, unlike bed/nozzle which do get
	// an explicit field back. That made a stale DB value persist forever
	// regardless of new set_temperature commands; the web server now writes
	// its own optimistic value on every command (setPrinterTemperatureTarget)
	// so this fallback carries forward a value that's actually current.
	chamberTarget := mFloatDef(printer, "chamberTarget", 0)
	if v, ok := decodeBambuChamberTarget(printData); ok {
		chamberTarget = round(v)
	}

	existingNozzleTargets := mSlice(printer, "nozzleTargets")
	fallbackNozzleTarget := 0.0
	if len(existingNozzleTargets) > 0 {
		if f, ok := asFloat(existingNozzleTargets[0]); ok {
			fallbackNozzleTarget = f
		}
	}
	nozzleTarget := fallbackNozzleTarget
	if v, ok := mFloat(printData, "nozzle_target_temper"); ok {
		nozzleTarget = round(v)
	}
	bedTarget := mFloatDef(printer, "bedTarget", 0)
	if v, ok := mFloat(printData, "bed_target_temper"); ok {
		bedTarget = round(v)
	}

	progress := 0
	if v, ok := mFloat(printData, "mc_percent"); ok {
		progress = clampInt(round(v), 0, 100)
	}
	remainingMinutes := 0
	if v, ok := mFloat(printData, "mc_remaining_time"); ok {
		remainingMinutes = int(maxF(0, round(v)))
	}

	lightOn := printer["lightOn"]
	for _, entryAny := range mSlice(printData, "lights_report") {
		entry := asMap(entryAny)
		if entry != nil && mStr(entry, "node") == "chamber_light" {
			lightOn = mStr(entry, "mode") == "on"
			break
		}
	}

	airFilterOn := printer["airFilterOn"]
	if airduct := asMap(mGet(asMap(printData["device"]), "airduct")); airduct != nil {
		if submode, ok := mFloat(airduct, "subMode"); ok {
			airFilterOn = int(submode) == 1
		}
	}

	var nozzleTemperatures, nozzleTargets []any
	if bambuDualNozzleProfiles[mStr(printer, "profile")] {
		nozzleTemperatures, nozzleTargets = buildBambuDualNozzles(
			printData, nozzleTemperature,
			mSlice(printer, "nozzleTemperatures"), mSlice(printer, "nozzleTargets"))
	} else {
		nozzleTemperatures = []any{nozzleTemperature}
		nozzleTargets = []any{nozzleTarget}
	}

	spools := buildBambuSpools(printData)
	if spools == nil {
		spools = printer["spools"]
	}
	currentJob := buildBambuCurrentJob(printData, mMap(printer, "currentJob"), progress, status, remainingMinutes)
	activeSpoolID := bambuActiveSpoolID(printData)
	activeTrayKey, _ := activeSpoolID.(string)
	updateBambuFilamentUsed(mStr(printer, "id"), currentJob, spools, mSlice(printData, "mapping"), activeTrayKey)

	fanSpeeds := buildBambuFanSpeeds(printData, mStr(printer, "profile"))
	if fanSpeeds == nil {
		fanSpeeds = printer["fanSpeeds"]
	}

	var rawPrintState any
	if s, ok := gcodeState.(string); ok {
		rawPrintState = strings.ToLower(s)
	}

	return pmap{
		"status":        status,
		"currentJob":    currentJob,
		"progress":      float64(progress),
		"rawPrintState": rawPrintState,
		"temperature": pmap{
			"nozzle":  nozzleTemperature,
			"bed":     bedTemperature,
			"chamber": chamberTemperature,
		},
		"nozzleTemperatures": nozzleTemperatures,
		"nozzleTargets":      nozzleTargets,
		"bedTarget":          bedTarget,
		"chamberTarget":      chamberTarget,
		"spools":             spools,
		"fanSpeeds":          fanSpeeds,
		"lightOn":            lightOn,
		"airFilterOn":        airFilterOn,
		"errorMessage":       buildBambuErrorMessage(printData, mStr(printer, "profile"), mStr(printer, "id")),
		"filamentRunout":     bambuFilamentRunout(printData),
		"activeSpoolId":      activeSpoolID,
	}, nil
}
