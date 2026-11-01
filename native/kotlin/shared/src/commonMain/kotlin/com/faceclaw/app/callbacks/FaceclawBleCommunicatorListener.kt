package com.faceclaw.app

interface FaceclawBleCommunicatorListener {
    fun onStateChange(phase: String?, status: String?): Unit

    fun onRingEvent(
        kind: String?,
        containerName: String?,
        eventType: Int,
        eventSource: Int,
        systemExitReasonCode: Int,
        frameId: Int,
        ringTick: Long,
        ringType: Int,
        ringAux: Int,
        ringSpeed: Int,
    ): Unit

    fun onBatteryState(
        headsetBattery: Int,
        headsetCharging: Int,
        ringBattery: Int,
        ringCharging: Int,
    ): Unit

    /**
     * The charging case, as the glasses relay it (sid 0x81 GlassesCaseInfo). caseBattery is
     * 0..100, or -1 when the reading carried no usable level (docking reports the glasses in
     * the case before the level). caseCharging 1 = the case is on USB power; lidStatus
     * 1 = closed, 0 = open; inCaseStatus 1 = glasses docked.
     */
    fun onCaseState(
        caseBattery: Int,
        caseCharging: Int,
        lidStatus: Int,
        inCaseStatus: Int,
    ): Unit

    fun onSilentMode(silent: Boolean): Unit

    fun onWearState(wearing: Boolean): Unit

    fun onPhoneLockState(locked: Boolean): Unit

    fun onEvenAppConflict(message: String?): Unit

    fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int): Unit

    fun onFrameFinished(frameId: Int, outcome: String?): Unit

    fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?): Unit
}
