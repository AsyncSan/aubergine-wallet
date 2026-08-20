/**
 * Settings, including the mode switch that ARCHITECTURE.md §4 calls the core
 * differentiator: a deliberate act with a warning, never automatic, and
 * permanently visible afterwards (the header badge).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { api } from '../../messaging/client';
import { AppError, errorI18nKey } from '../../core/errors';
import {
  AUTO_LOCK_OPTIONS_MINUTES,
  BEGINNER_NETWORK_IDS,
  effectiveNetworkId,
  isMainnetActive,
  LOCALES,
  type Locale,
  type Settings as SettingsType,
} from '../../core/settings';
import {
  allOriginsForNetwork,
  checkSorobanEndpoint,
  DAPP_CONNECTOR_ORIGINS,
  NETWORK_IDS,
  type EndpointRejection,
  type NetworkId,
} from '../../core/stellar/networks';
import {
  useAccounts,
  useAcknowledgeMainnet,
  useAddAccount,
  useUpdateSettings,
} from '../../state/queries';
import { useUiStore } from '../../state/store';
import { useMarkUiProgress } from '../../state/ui-progress';
import { dropOrigins, ensureOrigins } from '../permissions';
import { PasskeySection } from '../components/PasskeySection';
import {
  Button,
  Card,
  Field,
  Notice,
  ScreenHeader,
  Select,
  TextInput,
} from '../components/primitives';

/**
 * Typed confirmation for the Mainnet gate. Deliberately the same pattern as the
 * H4 reset ("LÖSCHEN"/"DELETE"), and deliberately *not* translated: the word is
 * the same in both locales so a screenshot-driven support answer can never send
 * someone the wrong one.
 */
export const MAINNET_CONFIRM_WORD = 'MAINNET';

/**
 * What the network picker shows, always the network the wallet is *actually*
 * on (finding 13).
 *
 * A stored `networkId` and the effective one can legitimately disagree:
 * `custom` without endpoints, `futurenet` left over from developer mode, or
 * `mainnet` without the acknowledgement all fall back in `effectiveNetworkId`.
 * Showing the stored value would then be a lie, and worse: a `<select>` whose
 * value matches no `<option>` renders *blank*, so the user saw an empty field
 * and could not tell where their money was.
 */
export function networkPickerValue(settings: SettingsType): NetworkId {
  return effectiveNetworkId(settings);
}

/**
 * The option list, guaranteed to contain {@link networkPickerValue}. Anything
 * the current mode does not otherwise offer is prepended rather than hidden,
 * an unlisted state must stay visible, not disappear.
 */
export function networkPickerOptions(settings: SettingsType): readonly NetworkId[] {
  const base: readonly NetworkId[] =
    settings.mode === 'developer'
      ? NETWORK_IDS.filter((id) => id !== 'custom')
      : BEGINNER_NETWORK_IDS;
  const current = networkPickerValue(settings);
  return base.includes(current) ? base : [current, ...base];
}

/** How long a revealed recovery phrase stays on screen before it hides again. */
export const PHRASE_AUTO_HIDE_SECONDS = 60;

/** i18n key for a rejected endpoint. One key per reason, "invalid" helps nobody. */
export function endpointErrorKey(reason: EndpointRejection): string {
  if (reason === 'not-https') return 'settings.rpc.errorHttps';
  if (reason === 'not-in-csp') return 'settings.rpc.errorHost';
  return 'settings.rpc.errorUrl';
}

/**
 * Host patterns that must be granted before an endpoint can be used.
 *
 * `chrome.permissions.request()` needs an origin pattern, and an arbitrary
 * third-party origin is not in `optional_host_permissions` unless we listed it
 *; the two Alchemy hosts are, everything else falls under the broad https
 * pattern the dApp connector already declares.
 */
export function endpointOriginPattern(url: string): string | null {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

export function Settings({
  settings,
  onExit,
  onReset,
}: {
  settings: SettingsType;
  onExit: () => void;
  onReset: () => void;
}): ReactNode {
  const { t } = useT();
  const update = useUpdateSettings();
  const acknowledgeMainnet = useAcknowledgeMainnet();
  const navigate = useUiStore((s) => s.navigate);
  const accountsQuery = useAccounts(true);
  const addAccount = useAddAccount();
  const markProgress = useMarkUiProgress();
  const [showModeWarning, setShowModeWarning] = useState(false);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phrasePassphrase, setPhrasePassphrase] = useState<string | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [showPhraseForm, setShowPhraseForm] = useState(false);
  const [phraseSecondsLeft, setPhraseSecondsLeft] = useState(PHRASE_AUTO_HIDE_SECONDS);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountPassword, setAccountPassword] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [showMainnetGate, setShowMainnetGate] = useState(false);
  const [mainnetConfirm, setMainnetConfirm] = useState('');
  const [rpcDraft, setRpcDraft] = useState(settings.sorobanRpcOverride ?? '');
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [rpcSaved, setRpcSaved] = useState(false);

  const isDeveloper = settings.mode === 'developer';
  const onMainnet = isMainnetActive(settings);
  /**
   * Beginners see Testnet + Mainnet; Futurenet stays a developer surface, plus
   * whatever the wallet is effectively on, so the field is never blank.
   */
  const networkOptions = networkPickerOptions(settings);

  /**
   * Invariant 6, as far as JavaScript allows: drop the phrase and both password
   * strings when the screen goes away, instead of leaving them in React state
   * until the popup happens to be torn down.
   */
  useEffect(() => {
    return () => {
      setPhrase(null);
      setPhrasePassphrase(null);
      setPassword('');
      setAccountPassword('');
    };
  }, []);

  /**
   * Auto-hide for the revealed phrase. Unmount cleanup above only helps when
   * the user leaves the screen; a popup opened as a tab can sit on Settings
   * for hours, with the most sensitive string in the product on display for
   * anyone walking past. Writing the phrase down takes well under a minute;
   * after that it disappears on its own and reveal needs the password again.
   */
  useEffect(() => {
    if (phrase === null) return;
    setPhraseSecondsLeft(PHRASE_AUTO_HIDE_SECONDS);
    const interval = setInterval(
      () => setPhraseSecondsLeft((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => clearInterval(interval);
  }, [phrase]);

  useEffect(() => {
    if (phrase === null || phraseSecondsLeft > 0) return;
    setPhrase(null);
    setPhrasePassphrase(null);
    setShowPhraseForm(false);
  }, [phrase, phraseSecondsLeft]);

  async function revealPhrase(): Promise<void> {
    setPhraseError(null);
    try {
      const res = await api.revealRecoveryPhrase(password);
      setPhrase(res.mnemonic);
      setPhrasePassphrase(res.bip39Passphrase);
      setPassword('');
      // The user has now genuinely seen the phrase, checklist "backup" done.
      await markProgress({ backupConfirmed: true });
    } catch (err) {
      setPhraseError(
        err instanceof AppError
          ? t(errorI18nKey(err.code), { seconds: err.detail ?? '?' })
          : t('error.INTERNAL_ERROR'),
      );
    }
  }

  /**
   * Finding B: only the Testnet endpoints are granted at install time. Any
   * other network needs its origins first, and the request has to happen in
   * this click/change handler because the browser demands a user gesture.
   */
  async function selectNetwork(id: NetworkId): Promise<void> {
    setPermissionNotice(null);
    setMainnetConfirm('');
    /**
     * v1.2 Mainnet gate: real funds are never one dropdown away. The first
     * switch to Mainnet opens the typed confirmation below; only that path
     * ever sets `mainnetAcknowledged`, and `effectiveNetworkId` keeps the
     * wallet on Testnet until it is set.
     */
    if (id === 'mainnet' && !settings.mainnetAcknowledged) {
      setShowMainnetGate(true);
      return;
    }
    // The whole chain, not just the primary: a fallback whose origin was never
    // granted is a fallback that cannot run.
    const origins = allOriginsForNetwork(
      id,
      settings.customNetwork ?? undefined,
      isDeveloper ? settings.sorobanRpcOverride : null,
    );
    if (!(await ensureOrigins(origins))) {
      setPermissionNotice(t('settings.permission.networkDenied'));
      return;
    }
    setShowMainnetGate(false);
    if (id === 'mainnet') {
      update.mutate({ networkId: id });
      return;
    }
    // Leaving Mainnet withdraws both the acknowledgement and the host access:
    // coming back has to pass the gate again.
    update.mutate({ networkId: id, mainnetAcknowledged: false });
    // The built-in mainnet chain only, never the user's own endpoint origin,
    // which is not tied to one network and may still serve the network we are
    // switching *to*. Removing that one is what `removeRpcOverride` is for.
    void dropOrigins(allOriginsForNetwork('mainnet'));
  }

  /** The gate itself; a click, so the permission prompt still has its gesture. */
  async function confirmMainnet(): Promise<void> {
    setPermissionNotice(null);
    if (mainnetConfirm.trim().toUpperCase() !== MAINNET_CONFIRM_WORD) return;
    if (
      !(await ensureOrigins(
        allOriginsForNetwork(
          'mainnet',
          undefined,
          isDeveloper ? settings.sorobanRpcOverride : null,
        ),
      ))
    ) {
      setPermissionNotice(t('settings.permission.networkDenied'));
      return;
    }
    // The acknowledgement goes through its own RPC, which also performs the
    // switch: `settings.set` refuses to raise the flag, so no replayed settings
    // object can open this gate.
    acknowledgeMainnet.mutate();
    setShowMainnetGate(false);
    setMainnetConfirm('');
  }

  /** Turning developer mode on is also when the connector's web access is asked for. */
  async function enableDeveloperMode(): Promise<void> {
    setPermissionNotice(null);
    const granted = await ensureOrigins(DAPP_CONNECTOR_ORIGINS);
    update.mutate({ mode: 'developer', developerModeAcknowledged: true });
    setShowModeWarning(false);
    if (!granted) setPermissionNotice(t('settings.permission.dappDenied'));
  }

  /**
   * Leaving developer mode gives the extra host access back, except for the
   * network the wallet is actually on. Since v1.2 a beginner may legitimately
   * be on Mainnet, so dropping those origins here would break the very network
   * the user just chose. Futurenet has no beginner equivalent and always goes.
   */
  function disableDeveloperMode(): void {
    setPermissionNotice(null);
    const keepMainnet = settings.networkId === 'mainnet' && settings.mainnetAcknowledged;
    update.mutate({ mode: 'beginner' });
    void dropOrigins([
      ...DAPP_CONNECTOR_ORIGINS,
      ...(keepMainnet ? [] : allOriginsForNetwork('mainnet')),
      ...allOriginsForNetwork('futurenet'),
      // The endpoint override is a developer-mode surface (`ctx.network()`
      // ignores it in beginner mode), so its host access goes back with it.
      // The value itself stays stored: coming back to developer mode should
      // not mean typing an API key in again.
      ...(settings.sorobanRpcOverride === null
        ? []
        : [endpointOriginPattern(settings.sorobanRpcOverride)].filter(
            (p): p is string => p !== null,
          )),
    ]);
  }

  /**
   * Save the user's own Soroban RPC endpoint.
   *
   * A click handler on purpose: `chrome.permissions.request()` needs a user
   * gesture, and an arbitrary origin is not granted at install time. Same
   * pattern as `selectNetwork` above.
   *
   * The value is validated *here* as well as in the protocol schema, because
   * a refusal the user can see next to the field they just typed in is worth
   * more than the same refusal arriving as a toast after a round trip.
   */
  async function saveRpcOverride(): Promise<void> {
    setRpcError(null);
    setRpcSaved(false);
    const value = rpcDraft.trim();
    if (value.length === 0) {
      await removeRpcOverride();
      return;
    }
    const rejection = checkSorobanEndpoint(value);
    if (rejection !== null) {
      setRpcError(t(endpointErrorKey(rejection)));
      return;
    }
    const pattern = endpointOriginPattern(value);
    if (pattern === null || !(await ensureOrigins([pattern]))) {
      setRpcError(t('settings.rpc.errorPermission'));
      return;
    }
    try {
      await update.mutateAsync({ sorobanRpcOverride: value });
      setRpcSaved(true);
    } catch (err) {
      // The detail never carries the value back (see protocol.ts), so showing
      // the translated code is both safe and all there is to say.
      setRpcError(
        err instanceof AppError ? t(errorI18nKey(err.code)) : t('error.INTERNAL_ERROR'),
      );
    }
  }

  /** Remove it and hand the host access back; a granted origin we no longer
   * use is a permission the user did not agree to keep. */
  async function removeRpcOverride(): Promise<void> {
    setRpcError(null);
    setRpcSaved(false);
    const previous = settings.sorobanRpcOverride;
    try {
      await update.mutateAsync({ sorobanRpcOverride: null });
      setRpcDraft('');
    } catch (err) {
      setRpcError(
        err instanceof AppError ? t(errorI18nKey(err.code)) : t('error.INTERNAL_ERROR'),
      );
      return;
    }
    if (previous !== null) {
      const pattern = endpointOriginPattern(previous);
      if (pattern !== null) void dropOrigins([pattern]);
    }
  }

  async function submitAddAccount(): Promise<void> {
    setAccountError(null);
    try {
      await addAccount.mutateAsync({ label: accountLabel, password: accountPassword });
      setAccountPassword('');
      setAccountLabel('');
      setShowAddAccount(false);
    } catch (err) {
      setAccountError(
        err instanceof AppError
          ? t(errorI18nKey(err.code), { seconds: err.detail ?? '?' })
          : t('error.INTERNAL_ERROR'),
      );
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <ScreenHeader title={t('settings.title')} onBack={onExit} />

      <Field label={t('settings.language')}>
        <Select
          value={settings.locale}
          onChange={(e) => update.mutate({ locale: e.target.value as Locale })}
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {t(`settings.language.${locale}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('settings.autoLock')}>
        <Select
          value={String(settings.autoLockMinutes)}
          onChange={(e) => update.mutate({ autoLockMinutes: Number(e.target.value) })}
        >
          {AUTO_LOCK_OPTIONS_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('settings.autoLockValue', { minutes })}
            </option>
          ))}
        </Select>
      </Field>

      {/*
        Passkey unlock sits directly under the auto-lock setting: both answer
        the same question ("how often do I type my password, and what happens
        when I do not"), and the shortcut belongs next to the thing it shortens.
      */}
      <PasskeySection />

      {/* ---- network (§4, v1.2: available in both modes, gated for Mainnet) ---- */}
      <Field label={t('settings.network')}>
        <Select
          value={networkPickerValue(settings)}
          onChange={(e) => void selectNetwork(e.target.value as NetworkId)}
        >
          {networkOptions.map((id) => (
            <option key={id} value={id}>
              {t(`settings.network.${id}`)}
            </option>
          ))}
        </Select>
      </Field>

      {showMainnetGate ? (
        <Card className="flex flex-col gap-2">
          <Notice tone="danger">
            <strong className="block pb-1">{t('settings.network.gateTitle')}</strong>
            {t('settings.network.gateBody')}
          </Notice>
          <Field label={t('settings.network.gateLabel', { word: MAINNET_CONFIRM_WORD })}>
            <TextInput
              value={mainnetConfirm}
              onChange={(e) => setMainnetConfirm(e.target.value)}
              placeholder={MAINNET_CONFIRM_WORD}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              tone="secondary"
              className="flex-1"
              onClick={() => {
                setShowMainnetGate(false);
                setMainnetConfirm('');
              }}
            >
              {t('app.cancel')}
            </Button>
            <Button
              tone="danger"
              className="flex-1"
              disabled={mainnetConfirm.trim().toUpperCase() !== MAINNET_CONFIRM_WORD}
              onClick={() => void confirmMainnet()}
            >
              {t('settings.network.gateAccept')}
            </Button>
          </div>
        </Card>
      ) : null}

      {onMainnet ? <Notice tone="danger">{t('settings.network.mainnetWarn')}</Notice> : null}

      {/* ---- mode switch (§4) ---- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('settings.mode')}
        </h2>
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">
                {t(isDeveloper ? 'settings.mode.developer' : 'settings.mode.beginner')}
              </p>
              <p className="pt-0.5 text-[11px] leading-relaxed text-muted">
                {t(
                  isDeveloper
                    ? 'settings.mode.developerBody'
                    : 'settings.mode.beginnerBody',
                )}
              </p>
            </div>
            <Button
              tone={isDeveloper ? 'secondary' : 'primary'}
              onClick={() => {
                if (isDeveloper) {
                  disableDeveloperMode();
                } else {
                  setShowModeWarning(true);
                }
              }}
            >
              {t(isDeveloper ? 'settings.mode.beginner' : 'settings.mode.developer')}
            </Button>
          </div>

          {showModeWarning && !isDeveloper ? (
            <div className="flex flex-col gap-2">
              <Notice tone="warn">
                <strong className="block pb-1">{t('settings.mode.warnTitle')}</strong>
                {t('settings.mode.warnBody')}
              </Notice>
              <div className="flex gap-2">
                <Button
                  tone="secondary"
                  className="flex-1"
                  onClick={() => setShowModeWarning(false)}
                >
                  {t('app.cancel')}
                </Button>
                <Button
                  tone="danger"
                  className="flex-1"
                  onClick={() => void enableDeveloperMode()}
                >
                  {t('settings.mode.warnAccept')}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
        {/* Host access is optional and can be declined, say so, never silently. */}
        {permissionNotice ? <Notice tone="warn">{permissionNotice}</Notice> : null}
      </section>

      {/* ---- developer-only surfaces (§4) ---- */}
      {isDeveloper ? (
        <>
          {/* ---- own Soroban RPC endpoint (v1.3) ---- */}
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t('settings.rpc')}
            </h2>
            <Card className="flex flex-col gap-2">
              <p className="text-xs text-muted">{t('settings.rpc.body')}</p>
              {/* The value is a credential; it must not be readable over a
                  shoulder, must not be offered to a password manager, and must
                  not be corrected by the browser's spell checker. */}
              <Field label={t('settings.rpc.label')}>
                <TextInput
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://…"
                  value={rpcDraft}
                  onChange={(e) => {
                    setRpcDraft(e.target.value);
                    setRpcError(null);
                    setRpcSaved(false);
                  }}
                />
              </Field>
              <p className="text-[11px] leading-relaxed text-muted">
                {t('settings.rpc.cspNote')}
              </p>
              {rpcError ? <Notice tone="danger">{rpcError}</Notice> : null}
              {rpcSaved ? <Notice>{t('settings.rpc.saved')}</Notice> : null}
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={update.isPending}
                  onClick={() => void saveRpcOverride()}
                >
                  {t('settings.rpc.save')}
                </Button>
                {settings.sorobanRpcOverride === null ? null : (
                  <Button
                    tone="secondary"
                    className="flex-1"
                    disabled={update.isPending}
                    onClick={() => void removeRpcOverride()}
                  >
                    {t('settings.rpc.remove')}
                  </Button>
                )}
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t('settings.origins')}
            </h2>
            {settings.allowedOrigins.length === 0 ? (
              <Card>
                <p className="text-xs text-muted">{t('settings.originsEmpty')}</p>
              </Card>
            ) : (
              settings.allowedOrigins.map((origin) => (
                <Card key={origin} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] text-text">
                    {origin}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-danger-fg"
                    onClick={() =>
                      update.mutate({
                        allowedOrigins: settings.allowedOrigins.filter((o) => o !== origin),
                      })
                    }
                  >
                    {t('settings.originsRemove')}
                  </button>
                </Card>
              ))
            )}
          </section>
        </>
      ) : null}

      {/* ---- accounts (finding 10: adding one re-encrypts the vault) ---- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('settings.accounts')}
        </h2>
        {(accountsQuery.data?.accounts ?? []).map((account) => (
          <Card key={account.index} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-text">
                {account.label || t('home.accountLabel', { index: account.index + 1 })}
              </p>
              <p className="truncate font-mono text-[10px] text-muted">{account.publicKey}</p>
            </div>
            {accountsQuery.data?.selectedIndex === account.index ? (
              <span className="shrink-0 text-[11px] text-accent-fg">
                {t('settings.accountSelected')}
              </span>
            ) : (
              <button
                type="button"
                className="shrink-0 text-xs text-accent-fg"
                onClick={() => {
                  void api.selectAccount(account.index).then(() => accountsQuery.refetch());
                }}
              >
                {t('settings.accountSelect')}
              </button>
            )}
          </Card>
        ))}
        {showAddAccount ? (
          <Card className="flex flex-col gap-2">
            <p className="text-xs text-muted">{t('settings.accountAddBody')}</p>
            <Field label={`${t('settings.accountLabel')} (${t('app.optional')})`}>
              <TextInput
                value={accountLabel}
                maxLength={64}
                onChange={(e) => setAccountLabel(e.target.value)}
              />
            </Field>
            <Field label={t('onboarding.password.label')}>
              <TextInput
                type="password"
                autoComplete="current-password"
                value={accountPassword}
                onChange={(e) => setAccountPassword(e.target.value)}
              />
            </Field>
            {accountError ? <Notice tone="danger">{accountError}</Notice> : null}
            <div className="flex gap-2">
              <Button
                tone="secondary"
                className="flex-1"
                onClick={() => {
                  setShowAddAccount(false);
                  setAccountPassword('');
                  setAccountError(null);
                }}
              >
                {t('app.cancel')}
              </Button>
              <Button
                className="flex-1"
                disabled={accountPassword.length === 0 || addAccount.isPending}
                onClick={() => void submitAddAccount()}
              >
                {t('app.confirm')}
              </Button>
            </div>
          </Card>
        ) : (
          <Button tone="secondary" onClick={() => setShowAddAccount(true)}>
            {t('settings.accountAdd')}
          </Button>
        )}
      </section>

      {/* ---- assets: second home of "add asset" (Home has the first) ---- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('settings.assets')}
        </h2>
        <Button tone="secondary" onClick={() => navigate('addAsset')}>
          {t('asset.add')}
        </Button>
      </section>

      {/* ---- recovery phrase ---- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('settings.recovery')}
        </h2>
        {phrase ? (
          <Card>
            <p className="text-sm leading-relaxed text-text">{phrase}</p>
            {/* Finding 7: without the 25th word the phrase restores a different wallet. */}
            {phrasePassphrase ? (
              <>
                <p className="pt-2 text-xs text-muted">{t('settings.recoveryPassphrase')}</p>
                <p className="text-sm leading-relaxed text-text">{phrasePassphrase}</p>
              </>
            ) : null}
            <p className="pt-2 text-xs text-muted">
              {t('settings.recoveryAutoHide', { seconds: phraseSecondsLeft })}
            </p>
            <button
              type="button"
              className="pt-2 text-xs text-accent-fg"
              onClick={() => {
                setPhrase(null);
                setPhrasePassphrase(null);
                setShowPhraseForm(false);
              }}
            >
              {t('app.close')}
            </button>
          </Card>
        ) : showPhraseForm ? (
          <Card className="flex flex-col gap-2">
            <p className="text-xs text-muted">{t('settings.recoveryBody')}</p>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {phraseError ? <Notice tone="danger">{phraseError}</Notice> : null}
            <Button disabled={password.length === 0} onClick={() => void revealPhrase()}>
              {t('app.confirm')}
            </Button>
          </Card>
        ) : (
          <Button tone="secondary" onClick={() => setShowPhraseForm(true)}>
            {t('settings.recovery')}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('settings.about')}
        </h2>
        <Notice>{t('settings.notAudited')}</Notice>
        <Button tone="danger" onClick={onReset}>
          {t('settings.reset')}
        </Button>
      </section>
    </div>
  );
}
