/**
 * UI state (Zustand). Navigation and ephemeral flow state only, anything
 * derived from the network lives in TanStack Query, anything persistent lives
 * in the background's settings store.
 */
import { create } from 'zustand';
import type { BuildIntent } from '../messaging/protocol';

export type Screen =
  | 'loading'
  | 'onboarding'
  | 'unlock'
  | 'home'
  | 'send'
  | 'swap'
  | 'receive'
  | 'addAsset'
  | 'history'
  | 'settings'
  | 'dappPrompt';

/** A transaction waiting for the confirmation dialog. */
export interface PendingSignature {
  readonly xdr: string;
  readonly intent: BuildIntent | null;
  /** Set when the request came from a web page rather than the popup. */
  readonly promptId: string | null;
  readonly origin: string | null;
}

interface UiState {
  screen: Screen;
  pending: PendingSignature | null;
  toast: { key: string; tone: 'ok' | 'error' } | null;
  navigate: (screen: Screen) => void;
  setPending: (pending: PendingSignature | null) => void;
  showToast: (key: string, tone?: 'ok' | 'error') => void;
  clearToast: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  screen: 'loading',
  pending: null,
  toast: null,
  navigate: (screen) => set({ screen }),
  setPending: (pending) => set({ pending }),
  showToast: (key, tone = 'ok') => set({ toast: { key, tone } }),
  clearToast: () => set({ toast: null }),
}));
