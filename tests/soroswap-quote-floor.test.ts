/**
 * Regression zum Live-Befund vom 18.08.2026 (Mainnet, read-only gemessen).
 *
 * `verifySoroswapEnvelope` lehnte JEDEN echten Aggregator-Envelope ab:
 *
 *   SWAP_ENVELOPE_MISMATCH: entry call guarantees 64585050
 *   instead of the promised minimum 64909597
 *
 * Ursache war nicht der Wächter, sondern der Maßstab, den er bekam. Die API
 * liefert in `/quote` ein `otherAmountThreshold`, das GLEICH `amountOut` ist —
 * also gar keine Slippage —, schreibt in `/quote/build` aber
 * `amount_out_min = amountOut * (1 - slippage)`. Das Wallet nahm den
 * Quote-Wert als garantierten Boden und maß den Envelope daran.
 *
 * Zwei Fehler in einem, und der zweite ist der schwerere:
 *
 * 1. Die Aggregator-Route war auf Mainnet vollständig tot.
 * 2. Der Swap-Bildschirm zeigte den ERWARTETEN Betrag als „du bekommst
 *    mindestens X". Die signierten Bytes trugen 0,5 % weniger. Ein
 *    Versprechen, das die Signatur nicht deckt.
 *
 * Die 681 Tests von vorher liefen alle grün durch diesen Fehler hindurch,
 * weil jede Vorrichtung `otherAmountThreshold` bereits slippage-bereinigt
 * ansetzte — also genau die Annahme, die falsch war. Die Fälle hier setzen
 * deshalb die GEMESSENEN Zahlen ein, nicht selbst gewählte.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { AppError } from '../src/core/errors';
import { MAINNET } from '../src/core/stellar/networks';
import {
  assetIdToContract,
  expectationOf,
  fetchSoroswapQuote,
  slippageFloor,
  verifySoroswapEnvelope,
  SOROSWAP_ENTRIES,
  type SoroswapConfig,
} from '../src/core/stellar/soroswap';

const CONFIG: SoroswapConfig = { apiUrl: 'https://api.example.test', apiKey: 'sk_test' };
const SOURCE = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';
const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Der gepinnte Mainnet-AMM-Router — 0x0dd5c710ea6a…, live bestätigt. */
const ROUTER =
  SOROSWAP_ENTRIES.get(MAINNET.passphrase)?.find((e) => e.role === 'router')?.id ?? '';

const USDC_SAC = assetIdToContract(USDC, MAINNET.passphrase);
const XLM_SAC = assetIdToContract('native', MAINNET.passphrase);

function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: 'i128' });
const addr = (v: string): xdr.ScVal => new Address(v).toScVal();

/**
 * Die Form, die live wirklich kam: der AMM-Router mit fünf Argumenten
 * (amount_in, amount_out_min, path, to, deadline), ein Auth-Eintrag, darin
 * der `transfer`, der die Eingabe bezahlt.
 */
function routerEnvelope(amountIn: bigint, amountOutMin: bigint): string {
  const args = [
    i128(amountIn),
    i128(amountOutMin),
    xdr.ScVal.scvVec([addr(USDC_SAC), addr(XLM_SAC)]),
    addr(SOURCE),
    nativeToScVal(1_900_000_000n, { type: 'u64' }),
  ];
  const call = new xdr.InvokeContractArgs({
    contractAddress: new Address(ROUTER).toScAddress(),
    functionName: 'swap_exact_tokens_for_tokens',
    args,
  });
  const transfer = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(USDC_SAC).toScAddress(),
        functionName: 'transfer',
        args: [addr(SOURCE), addr(ROUTER), i128(amountIn)],
      }),
    ),
    subInvocations: [],
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [transfer],
    }),
  });
  return new TransactionBuilder(new Account(SOURCE, '100'), {
    fee: '1000000',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(call),
        auth: [auth],
      }),
    )
    .setTimeout(180)
    .build()
    .toXDR();
}

/* ------------------------------------------------------------ Arithmetik */

describe('slippageFloor', () => {
  /** Beide Zahlenpaare stammen aus dem Mainnet-Lauf, nicht aus dem Kopf. */
  it('liegt bei den zwei gemessenen Envelopes unter dem, was die Kette garantiert', () => {
    for (const [amountOut, envelopeMin] of [
      ['64909597', 64585050n],
      ['74456861', 74084577n],
    ] as const) {
      const floor = BigInt(slippageFloor(amountOut, 50));
      expect(envelopeMin >= floor, `${amountOut}: Envelope ${envelopeMin} < Boden ${floor}`).toBe(
        true,
      );
      // Und nicht beliebig darunter: der Boden ist höchstens eine Stroop
      // kleiner als das, was die API kaufmännisch gerundet einsetzt.
      expect(envelopeMin - floor).toBeLessThanOrEqual(1n);
    }
  });

  it('rundet ab, damit das Versprechen in jedem Fall gedeckt bleibt', () => {
    expect(slippageFloor('64909597', 50)).toBe('64585049');
    expect(slippageFloor('10000000', 0)).toBe('10000000');
    expect(slippageFloor('10000000', 10_000)).toBe('0');
  });
});

/* ------------------------------------------------------------------ Quote */

describe('fetchSoroswapQuote: der Boden kommt aus der Slippage, nicht aus der API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Exakt die Antwortform, die die Mainnet-API am 18.08.2026 lieferte. */
  const LIVE_BODY = {
    amountIn: '10000000',
    amountOut: '64909597',
    otherAmountThreshold: '64909597', // === amountOut, KEINE Slippage
    tradeType: 'EXACT_IN',
    platform: 'router',
    priceImpactPct: '0.00',
  };

  it('übernimmt otherAmountThreshold NICHT als garantierten Boden', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, LIVE_BODY));
    const quote = await fetchSoroswapQuote(CONFIG, MAINNET, USDC, '1', 'native', 50);
    expect(quote).not.toBeNull();
    // Der Kern: der API-Wert wäre 64909597 gewesen, das ist der ERWARTETE
    // Betrag. Versprochen wird der um die Slippage gesenkte Boden.
    expect(quote?.minOutStroops).toBe('64585049');
    expect(quote?.minOutStroops).not.toBe(LIVE_BODY.otherAmountThreshold);
    expect(quote?.amountOutStroops).toBe('64909597');
  });

  it('zeigt dem Nutzer denselben Boden, den der Wächter misst', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, LIVE_BODY));
    const quote = await fetchSoroswapQuote(CONFIG, MAINNET, USDC, '1', 'native', 50);
    // "du bekommst mindestens X" und der Maßstab des Wächters müssen
    // derselbe Wert sein, sonst verspricht der Bildschirm etwas, das die
    // Signatur nicht deckt. Genau das war der Fehler.
    expect(quote?.minReceived).toBe('6.4585049');
    expect(expectationOf(quote!).minOutStroops).toBe(quote?.minOutStroops);
  });

  it('folgt der eingestellten Slippage, nicht einem festen Wert', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, LIVE_BODY));
    const quote = await fetchSoroswapQuote(CONFIG, MAINNET, USDC, '1', 'native', 300);
    expect(quote?.minOutStroops).toBe(slippageFloor('64909597', 300));
  });
});

/* ------------------------------------------------ Wächter gegen die Kette */

describe('verifySoroswapEnvelope gegen die live gemessene Envelope-Form', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function liveQuote(slippageBps = 50) {
    vi.stubGlobal(
      'fetch',
      fetchReturning(200, {
        amountIn: '10000000',
        amountOut: '64909597',
        otherAmountThreshold: '64909597',
        tradeType: 'EXACT_IN',
        platform: 'router',
      }),
    );
    const quote = await fetchSoroswapQuote(CONFIG, MAINNET, USDC, '1', 'native', slippageBps);
    vi.unstubAllGlobals();
    return quote!;
  }

  it('nimmt den Envelope an, den der Router live zurückgab', async () => {
    const quote = await liveQuote();
    // 64585050 ist die Zahl aus dem echten Envelope, nicht nachgerechnet.
    const tx = verifySoroswapEnvelope(
      routerEnvelope(10_000_000n, 64_585_050n),
      MAINNET,
      SOURCE,
      expectationOf(quote),
    );
    expect(tx.source).toBe(SOURCE);
  });

  it('nimmt auch den zweiten gemessenen Fall an', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(200, {
        amountIn: '10000000',
        amountOut: '74456861',
        otherAmountThreshold: '74456861',
        tradeType: 'EXACT_IN',
      }),
    );
    const quote = await fetchSoroswapQuote(CONFIG, MAINNET, USDC, '1', 'native', 50);
    vi.unstubAllGlobals();
    const tx = verifySoroswapEnvelope(
      routerEnvelope(10_000_000n, 74_084_577n),
      MAINNET,
      SOURCE,
      expectationOf(quote!),
    );
    expect(tx.source).toBe(SOURCE);
  });

  it('lehnt weiterhin ab, was UNTER der eingestellten Slippage liegt', async () => {
    const quote = await liveQuote();
    // Eine Stroop unter dem Boden: das Versprechen wäre nicht mehr gedeckt.
    expect(() =>
      verifySoroswapEnvelope(
        routerEnvelope(10_000_000n, 64_585_048n),
        MAINNET,
        SOURCE,
        expectationOf(quote),
      ),
    ).toThrow(AppError);
  });

  it('lehnt eine gröbere Absenkung erst recht ab', async () => {
    const quote = await liveQuote();
    expect(() =>
      verifySoroswapEnvelope(
        routerEnvelope(10_000_000n, 32_000_000n),
        MAINNET,
        SOURCE,
        expectationOf(quote),
      ),
    ).toThrow(AppError);
  });

  it('bleibt bei enger Slippage streng: 10 bps versprochen, 50 bps geliefert', async () => {
    const quote = await liveQuote(10);
    // Der Nutzer hat 0,1 % erlaubt, der Envelope trägt 0,5 % — das ist eine
    // schlechtere Position als zugesagt und muss auffallen.
    expect(() =>
      verifySoroswapEnvelope(
        routerEnvelope(10_000_000n, 64_585_050n),
        MAINNET,
        SOURCE,
        expectationOf(quote),
      ),
    ).toThrow(AppError);
  });
});
