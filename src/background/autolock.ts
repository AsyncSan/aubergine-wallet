/**
 * Auto-lock timer (ARCHITECTURE.md §3, default 15 minutes).
 *
 * MV3 service workers are killed at will, so the deadline is kept in
 * `chrome.alarms` *and* checked on every RPC. A suspended worker loses the
 * in-memory keyring anyway, which fails safe: the wallet is then locked.
 */
import { browser } from 'wxt/browser';

const ALARM_NAME = 'aubergine:autolock';

export class AutoLock {
  #deadline: number | null = null;
  #minutes: number;

  constructor(
    minutes: number,
    private readonly onExpire: () => void,
  ) {
    this.#minutes = minutes;
  }

  get deadline(): number | null {
    return this.#deadline;
  }

  setMinutes(minutes: number): void {
    this.#minutes = minutes;
    if (this.#deadline !== null) void this.touch();
  }

  /** Restart the countdown. Called after every successful authenticated RPC. */
  async touch(): Promise<void> {
    this.#deadline = Date.now() + this.#minutes * 60_000;
    try {
      await browser.alarms.clear(ALARM_NAME);
      await browser.alarms.create(ALARM_NAME, { delayInMinutes: this.#minutes });
    } catch {
      /* alarms unavailable in tests */
    }
  }

  async cancel(): Promise<void> {
    this.#deadline = null;
    try {
      await browser.alarms.clear(ALARM_NAME);
    } catch {
      /* ignore */
    }
  }

  /** Returns true when the deadline has passed (and fires `onExpire`). */
  checkExpired(): boolean {
    if (this.#deadline !== null && Date.now() >= this.#deadline) {
      this.onExpire();
      this.#deadline = null;
      return true;
    }
    return false;
  }

  handleAlarm(name: string): void {
    if (name !== ALARM_NAME) return;
    this.onExpire();
    this.#deadline = null;
  }

  static get alarmName(): string {
    return ALARM_NAME;
  }
}
