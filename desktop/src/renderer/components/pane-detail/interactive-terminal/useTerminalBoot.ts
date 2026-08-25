import type { MuxBasePane } from 'muxbase/core';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  appendTerminalTail,
  hasUserInputPrompt,
  isAgentBootReady,
} from '../../../lib/terminal-boot-detection';

const BOOT_HARD_TIMEOUT_MS = 45_000;
const BOOT_SOFT_TIMEOUT_MS = 15_000;
const MIN_BOOT_MS = 200;
const OUTPUT_TAIL_MAX = 6_000;

interface UseTerminalBootOptions {
  activityIdle: boolean;
  agent: MuxBasePane['agent'];
  initialBooting: boolean;
  lockInput: () => void;
  sessionWaiting: boolean;
  terminalFailure: boolean;
  unlockInput: () => void;
}

interface UseTerminalBootResult {
  booting: boolean;
  bootingRef: RefObject<boolean>;
  bootPhase: number;
  clearMinimumUnlockTimer: () => void;
  onTerminalInput: (data: string) => void;
  onTerminalOutput: (data: string) => void;
  outputTailRef: RefObject<string>;
  reset: (showOverlay: boolean) => void;
  startupCompleteRef: RefObject<boolean>;
  tryCompleteIfReady: (tail: string) => boolean;
}

export function useTerminalBoot({
  activityIdle,
  agent,
  initialBooting,
  lockInput,
  sessionWaiting,
  terminalFailure,
  unlockInput,
}: UseTerminalBootOptions): UseTerminalBootResult {
  const [booting, setBooting] = useState(initialBooting);
  const [bootPhase, setBootPhase] = useState(0);
  const [resetEpoch, setResetEpoch] = useState(0);
  const awaitingUserInputRef = useRef(false);
  const bootingRef = useRef(initialBooting);
  const bootStartRef = useRef(Date.now());
  const minimumUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputTailRef = useRef('');
  const sessionWaitingRef = useRef(sessionWaiting);
  const startupCompleteRef = useRef(!initialBooting);
  sessionWaitingRef.current = sessionWaiting;

  const clearMinimumUnlockTimer = useCallback(() => {
    if (!minimumUnlockTimerRef.current) return;
    clearTimeout(minimumUnlockTimerRef.current);
    minimumUnlockTimerRef.current = null;
  }, []);

  const completeStartup = useCallback(() => {
    if (!bootingRef.current && startupCompleteRef.current) return;
    bootingRef.current = false;
    startupCompleteRef.current = true;
    awaitingUserInputRef.current = false;
    setBooting(false);
    clearMinimumUnlockTimer();
    unlockInput();
  }, [clearMinimumUnlockTimer, unlockInput]);

  const tryCompleteIfReady = useCallback((tail: string): boolean => {
    if (startupCompleteRef.current) return false;
    if (Date.now() - bootStartRef.current < MIN_BOOT_MS) return false;
    if (!isAgentBootReady(agent, tail)) return false;
    completeStartup();
    return true;
  }, [agent, completeStartup]);

  const pauseForUserInput = useCallback(() => {
    awaitingUserInputRef.current = true;
    if (!bootingRef.current) {
      unlockInput();
      return;
    }
    bootingRef.current = false;
    setBooting(false);
    clearMinimumUnlockTimer();
    unlockInput();
  }, [clearMinimumUnlockTimer, unlockInput]);

  const restartAfterUserInput = useCallback(() => {
    if (!agent || startupCompleteRef.current) return;
    if (isAgentBootReady(agent, outputTailRef.current)) {
      completeStartup();
      return;
    }
    awaitingUserInputRef.current = false;
    outputTailRef.current = '';
    bootStartRef.current = Date.now();
    bootingRef.current = true;
    lockInput();
    setBooting(true);
    setBootPhase(0);
    clearMinimumUnlockTimer();
  }, [agent, clearMinimumUnlockTimer, completeStartup, lockInput]);

  const onTerminalInput = useCallback((data: string) => {
    if (!startupCompleteRef.current && awaitingUserInputRef.current && /[\r\n]/.test(data)) {
      restartAfterUserInput();
    }
  }, [restartAfterUserInput]);

  const onTerminalOutput = useCallback((data: string) => {
    outputTailRef.current = appendTerminalTail(outputTailRef.current, data, OUTPUT_TAIL_MAX);
    const tail = outputTailRef.current;
    const bootReady = !startupCompleteRef.current && isAgentBootReady(agent, tail);
    if (!startupCompleteRef.current && !bootReady && hasUserInputPrompt(tail)) {
      pauseForUserInput();
    }
    if (!tryCompleteIfReady(tail) && bootingRef.current && !startupCompleteRef.current
      && bootReady && !minimumUnlockTimerRef.current) {
      const remainingMs = Math.max(0, MIN_BOOT_MS - (Date.now() - bootStartRef.current));
      minimumUnlockTimerRef.current = setTimeout(() => {
        minimumUnlockTimerRef.current = null;
        if (bootingRef.current) completeStartup();
      }, remainingMs);
    }
  }, [agent, completeStartup, pauseForUserInput, tryCompleteIfReady]);

  const reset = useCallback((showOverlay: boolean) => {
    const waitingForUser = showOverlay && sessionWaitingRef.current;
    const shouldBoot = showOverlay && !waitingForUser;
    awaitingUserInputRef.current = waitingForUser;
    bootStartRef.current = Date.now();
    bootingRef.current = shouldBoot;
    outputTailRef.current = '';
    startupCompleteRef.current = !showOverlay;
    setBooting(shouldBoot);
    setBootPhase(0);
    setResetEpoch((epoch) => epoch + 1);
    clearMinimumUnlockTimer();
  }, [clearMinimumUnlockTimer]);

  useEffect(() => clearMinimumUnlockTimer, [clearMinimumUnlockTimer]);

  useEffect(() => {
    if (!agent || startupCompleteRef.current || !booting || terminalFailure) return;
    const timer = setTimeout(() => {
      if (!bootingRef.current || startupCompleteRef.current) return;
      unlockInput();
    }, BOOT_SOFT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [agent, booting, resetEpoch, terminalFailure, unlockInput]);

  useEffect(() => {
    if (!agent || startupCompleteRef.current || !booting || terminalFailure) return;
    const timer = setTimeout(() => {
      if (!bootingRef.current || startupCompleteRef.current) return;
      completeStartup();
    }, BOOT_HARD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [agent, booting, completeStartup, resetEpoch, terminalFailure]);

  useEffect(() => {
    if (!agent || startupCompleteRef.current) return;
    if (sessionWaiting) pauseForUserInput();
    else if (activityIdle) completeStartup();
  }, [activityIdle, agent, completeStartup, pauseForUserInput, resetEpoch, sessionWaiting]);

  useEffect(() => {
    if (!booting) {
      setBootPhase(0);
      return;
    }
    const phaseOneTimer = setTimeout(() => setBootPhase(1), 1_500);
    const phaseTwoTimer = setTimeout(() => setBootPhase(2), 4_000);
    const phaseThreeTimer = setTimeout(() => setBootPhase(3), BOOT_SOFT_TIMEOUT_MS);
    return () => {
      clearTimeout(phaseOneTimer);
      clearTimeout(phaseTwoTimer);
      clearTimeout(phaseThreeTimer);
    };
  }, [booting, resetEpoch]);

  return {
    booting,
    bootingRef,
    bootPhase,
    clearMinimumUnlockTimer,
    onTerminalInput,
    onTerminalOutput,
    outputTailRef,
    reset,
    startupCompleteRef,
    tryCompleteIfReady,
  };
}
