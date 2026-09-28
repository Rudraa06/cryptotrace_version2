/**
 * components/EmptyState.jsx
 * ---------------------------------------------------------------------------
 * Three distinct empty states matching the backend's `reason` field.
 * Each explains what happened AND how to fix it.
 */

/** Wallets that SEND funds to exchanges — good for tracing a money trail. */
const DEMO_WALLETS = [
  { label: 'Test Case 1: Peeling Chain', address: '0x7a400444318d19b01457d9b70cbe9d050ed5260b' },
  { label: 'Test Case 2: Cross-Chain Bridge', address: '0x849fec52b628040ddcb3b23c3004d3deaa19c341' },
  { label: 'Test Case 3: Mixer (Tornado Cash)', address: '0x4775602b625d762ab7a07cd6ac303c63ad153ed9' },
  { label: 'Test Case 4: Micro-Structuring', address: '0x01a30a483adf33b5b198c85baf55fde59784b597' },
];

/**
 * @param {object} props
 * @param {object} props.data        Backend trace response (with found: false).
 * @param {(address: string) => void} [props.onTryAddress]  Called when user picks a demo wallet.
 */
export default function EmptyState({ data, onTryAddress }) {
  if (!data || data.found !== false) return null;

  // Detect when the queried address IS itself a known exchange.
  // shortestPath excludes the start node from being the destination, so tracing
  // an exchange wallet will always return NO_ROUTE_FOUND — but the reason is
  // completely different from "funds haven't cashed out yet".
  const isExchangeItself =
    data.reason === 'NO_ROUTE_FOUND' && data.start?.isExchange === true;

  // WALLET_NOT_IN_GRAPH can mean two things:
  //   (a) ingestion ran but found no transfers in the tracked asset set
  //   (b) ?ingest=false was passed and we deliberately skipped ingestion
  const noTransfers =
    data.reason === 'WALLET_NOT_IN_GRAPH' &&
    data.ingestion?.attempted === true &&
    data.ingestion?.wroteAnything === false;

  // Exchange name from start node (populated when it's a seeded exchange)
  const exchangeName = data.start?.exchange ?? 'Exchange';

  const configs = {
    WALLET_NOT_IN_GRAPH: noTransfers
      ? {
          icon: '📭',
          title: 'No Tracked Transfers Found',
          color: 'var(--color-text-secondary)',
          description:
            'The blockchain was searched but this address has no transfers in ' +
            'the tracked asset set (ETH and major stablecoins). It may hold only ' +
            'ERC-20 tokens, have zero activity, or have only received funds.',
          tip: 'Try one of the intermediary wallets below — they actively send ETH/USDT to exchanges.',
          showDemoWallets: true,
        }
      : {
          icon: '🔍',
          title: 'Wallet Not Yet Ingested',
          color: 'var(--color-text-accent)',
          description:
            'The system is ingesting this address from the blockchain. ' +
            'If you see this after a trace completes, the wallet had no outgoing ' +
            'transfers in the tracked asset set.',
          tip: 'The trace runs automatically. If it keeps failing, try one of the wallets below.',
          showDemoWallets: true,
        },
    NO_EXCHANGES_SEEDED: {
      icon: '⚠️',
      title: 'No Exchanges in Database',
      color: 'var(--color-status-warn)',
      description:
        'The graph has no exchange wallets flagged, so no route can be found. ' +
        'Run "npm run seed:exchanges" in the backend directory to fix this.',
      tip: null,
      showDemoWallets: false,
    },
    NO_ROUTE_FOUND: isExchangeItself
      ? {
          icon: '🏦',
          title: `This IS a ${exchangeName} Wallet`,
          color: '#ef4444',
          description:
            `You entered a ${exchangeName} hot wallet address — this is the cash-out destination, ` +
            'not a suspect wallet. To trace a money trail, paste a wallet that SENT funds to this exchange.',
          tip: 'Paste a suspect wallet address (the source of funds). The trace will show you the path to the exchange.',
          showDemoWallets: true,
        }
      : {
          icon: '🛤️',
          title: 'No Route to an Exchange',
          color: 'var(--color-text-secondary)',
          description:
            'The wallet is in the graph but no path to a known exchange was found ' +
            'within the hop limit. The funds may still be sitting in an intermediary ' +
            'wallet, or the exchange isn\'t in our registry yet.',
          tip: 'Try increasing Max Hops (slider in the search bar) or trace a deeper on-chain history first.',
          showDemoWallets: true,
        },
  };

  const cfg = configs[data.reason] ?? {
    icon: '❓',
    title: 'No Results',
    color: 'var(--color-text-secondary)',
    description: data.message ?? 'The trace did not find any results.',
    tip: null,
    showDemoWallets: false,
  };

  return (
    <div className="glass-card p-6 text-center animate-fade-in max-w-lg mx-auto">
      <div className="text-4xl mb-3">{cfg.icon}</div>
      <h3 className="text-base font-semibold mb-2" style={{ color: cfg.color }}>
        {cfg.title}
      </h3>
      <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-3">
        {cfg.description}
      </p>

      {cfg.tip && (
        <p className="text-xs text-[var(--color-text-muted)] bg-[rgba(255,255,255,0.04)] rounded-lg p-3 leading-relaxed mb-4">
          💡 {cfg.tip}
        </p>
      )}

      {cfg.showDemoWallets && onTryAddress && (
        <div className="mt-3">
          <p className="text-xs text-[var(--color-text-muted)] mb-2 font-medium uppercase tracking-wider">
            {isExchangeItself ? 'Try an intermediary (source) wallet' : 'Try a wallet'}
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            {DEMO_WALLETS.filter(w => isExchangeItself ? !w.isExchange : true).map(({ label, address }) => (
              <button
                key={address}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('fill-demo', { detail: { address, label } }));
                  onTryAddress(address);
                }}
                className="text-xs px-3 py-1.5 rounded-full border border-[var(--color-border-subtle)]
                           text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]
                           hover:border-[var(--color-accent-from)] hover:bg-[rgba(99,102,241,0.08)]
                           transition-all duration-200 font-mono"
                title={address}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {data.stats?.exchangeWalletsInGraph !== undefined && (
        <p className="text-xs text-[var(--color-text-muted)] mt-4">
          Exchanges in graph:{' '}
          <span className="font-semibold text-[var(--color-text-secondary)]">
            {data.stats.exchangeWalletsInGraph}
          </span>
        </p>
      )}
    </div>
  );
}
