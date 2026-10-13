/**
 * Browser half of dsh-account-usage-widget.
 *
 * A hand-written client bundle for dsh 0.2.0-rc.2: it registers one lazy
 * factory, renders a compact floating "account usage" pill into the frame-wide
 * `shell.overlay` slot, and reads the account through the already-mounted
 * `account` Remote namespace. Nothing else is imported — React comes from the
 * browser module table, and every style uses host theme tokens, so the widget
 * follows light/dark switching without any build step.
 *
 * The account data contract (dsh-api-account-controller / dsh-deepseek-account):
 *   getState()        -> { ok: true, value: AccountView }
 *   watch(signal)     -> stream of { value: AccountView }
 *   getProfile(client)-> { ok: true, value: { status: 'ready', value: AccountProfile } | { status: 'failed' } }
 *   getBalance(client)-> { ok: true, value: { status: 'ready', value: AccountWallet[], bonusWallets: AccountWallet[] } | { status: 'failed' } }
 * with AccountWallet = { currency: 'CNY' | 'USD', balance: string }.
 */
window.__ModuleLoader__.load({
  id: 'dsh-account-usage-widget',
  factory(require) {
    'use strict';

    // React is a platform seed module; normalize ESM-namespace and CJS shapes.
    const ReactSeed = require('react');
    const React =
      ReactSeed !== null && typeof ReactSeed === 'object' && typeof ReactSeed.useState === 'function'
        ? ReactSeed
        : (ReactSeed && ReactSeed.default) || ReactSeed;
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Client locale namespace, and the overlay entry key (the package name keeps it collision-free). */
    const NAMESPACE = 'account-usage-widget';
    const SLOT = 'shell.overlay';
    const ENTRY_ID = 'dsh-account-usage-widget';
    /** String only the Platform request headers echo back; the widget never changes it into behaviour. */
    const CLIENT_VERSION = '0.2.0-rc.2';
    /** Balance refresh cadence while the page is visible; live login state arrives over the watch stream. */
    const POLL_INTERVAL_MS = 30000;
    /** Link safety for the Platform usage page opened in a new tab. */
    const LINK_REL = 'noreferrer noopener';

    const en = {
      'title': 'Account usage',
      'signedIn': 'Signed in',
      'balance': 'Balance',
      'bonus': 'Bonus credit',
      'spentSinceOpen': 'Used since opened',
      'sessionUsage': 'This session',
      'tokensIn': 'Input',
      'tokensOut': 'Output',
      'cacheRead': 'Cache read',
      'loading': 'Reading…',
      'signedOut': 'Not signed in',
      'signedOutHint': 'Sign in from Settings → Account to see your balance here.',
      'failed': 'Could not read the account',
      'retry': 'Retry',
      'refresh': 'Refresh',
      'updated': 'Updated {time}',
      'updatedNever': 'Not read yet',
      'openUsage': 'Usage details',
      'expand': 'Expand account usage',
      'collapse': 'Collapse account usage',
    };
    const zh = {
      'title': '账户用量',
      'signedIn': '已登录',
      'balance': '充值余额',
      'bonus': '赠送额度',
      'spentSinceOpen': '本次打开已用',
      'sessionUsage': '本会话用量',
      'tokensIn': '输入',
      'tokensOut': '输出',
      'cacheRead': '缓存读',
      'loading': '读取中…',
      'signedOut': '未登录',
      'signedOutHint': '在「设置 → 账户」登录后即可在此查看余额。',
      'failed': '账户信息读取失败',
      'retry': '重试',
      'refresh': '刷新',
      'updated': '更新于 {time}',
      'updatedNever': '尚未读取',
      'openUsage': '用量明细',
      'expand': '展开账户用量',
      'collapse': '收起账户用量',
    };

    /** Currency symbols for the two currencies the account API admits. */
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

    /** Currency symbol, falling back to the code so an unknown currency still reads. */
    function currencySymbol(currency) {
      return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
    }

    /** Trim a decimal string to two significant decimals without inventing precision. */
    function formatAmount(value) {
      const text = typeof value === 'string' ? value.trim() : String(value ?? '');
      if (text === '') return '0';
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return text;
      const fixed = Math.abs(numeric) >= 100000 ? numeric.toFixed(0) : numeric.toFixed(2);
      return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }

    /** Sum each currency independently; wallets keep their own currency and amount. */
    function totalsOf(wallets) {
      const totals = new Map();
      for (const wallet of wallets ?? []) {
        const amount = Number(wallet?.balance);
        if (!Number.isFinite(amount)) continue;
        totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + amount);
      }
      return totals;
    }

    /** One balance line per currency, in the order the Platform reported them. */
    function walletRows(wallets) {
      const rows = [];
      const seen = new Set();
      for (const wallet of wallets ?? []) {
        if (wallet === null || typeof wallet !== 'object' || seen.has(wallet.currency)) continue;
        seen.add(wallet.currency);
        rows.push({ currency: wallet.currency, text: `${currencySymbol(wallet.currency)}${formatAmount(wallet.balance)}` });
      }
      return rows;
    }

    /** Compact token counts: 812, 6.8k, 12.3k, 123k, 1.2M. */
    function formatTokens(value) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
      if (!Number.isFinite(count) || count < 0) return '0';
      if (count < 1000) return String(Math.round(count));
      if (count < 1000000) {
        const thousands = count / 1000;
        return `${thousands < 100 ? thousands.toFixed(1) : String(Math.round(thousands))}k`;
      }
      return `${(count / 1000000).toFixed(1)}M`;
    }

    /** Local wall-clock time for the "updated" caption. */
    function formatClock(timestamp) {
      const date = new Date(timestamp);
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** Read-only account projection the widget subscribes to. */
    function createUsageStore(accountRemote, ctx) {
      let state = {
        phase: 'loading', // loading | ready | signed-out | failed
        view: null,
        profile: null,
        balance: null,
        failed: false,
        updatedAt: 0,
      };
      const listeners = new Set();
      let inflight;
      let pollTimer;
      let streamDispose;
      let visibilityHandler;
      let baseline;
      let generation = 0;
      let disposed = false;

      const get = () => state;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const notify = () => {
        for (const listener of [...listeners]) listener();
      };
      const publish = (patch) => {
        state = { ...state, ...patch };
        notify();
      };

      /** Identity carried by every call that reaches the Platform; read at call time for the live language and zone. */
      const identity = () => ({
        version: CLIENT_VERSION,
        locale: ctx.locale.getSnapshot().active,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });

      async function read() {
        if (disposed) return;
        if (state.view === null) {
          try {
            const result = await accountRemote.getState();
            if (!disposed && result !== null && typeof result === 'object' && result.ok === true) publish({ view: result.value });
          } catch (_error) {
            /* a refused state read keeps the loading phase until the watch stream or the next poll answers */
          }
        }
        const view = state.view;
        if (view === null || view.status !== 'credential-stored') {
          publish({ phase: view === null ? 'loading' : 'signed-out', balance: null, profile: null, failed: false });
          return;
        }
        const mark = ++generation;
        try {
          const [balanceResult, profileResult] = await Promise.all([
            accountRemote.getBalance(identity()),
            accountRemote.getProfile(identity()),
          ]);
          if (disposed || mark !== generation) return;
          const detail = balanceResult !== null && typeof balanceResult === 'object' && balanceResult.ok === true ? balanceResult.value : undefined;
          // null is the account owner saying "no grant": signed out, never a zero balance.
          // `{ status: 'failed' }` is a query failure and must not erase the previous reading.
          if (detail === null) {
            baseline = undefined;
            publish({ phase: 'signed-out', view: { ...view, status: 'signed-out' }, balance: null, profile: null, failed: false });
            return;
          }
          const balance =
            detail !== undefined && detail.status === 'ready'
              ? { wallets: detail.value ?? [], bonus: detail.bonusWallets ?? [] }
              : null;
          const profileDetail = profileResult !== null && typeof profileResult === 'object' && profileResult.ok === true ? profileResult.value : undefined;
          const profile = profileDetail !== undefined && profileDetail !== null && profileDetail.status === 'ready' ? profileDetail.value : null;
          if (balance !== null && baseline === undefined) baseline = totalsOf(balance.wallets);
          publish({
            phase: balance === null ? 'failed' : 'ready',
            balance: balance === null ? state.balance : balance,
            profile: profile === null ? state.profile : profile,
            failed: balance === null,
            updatedAt: Date.now(),
          });
        } catch (_error) {
          if (disposed || mark !== generation) return;
          // A carrier or query failure keeps the last reading and only marks it stale.
          publish({ phase: 'failed', failed: true });
        }
      }

      /** Coalesced refresh: one read in flight, callers share its settlement. */
      function refresh() {
        if (inflight !== undefined) return inflight;
        const run = read();
        inflight = run;
        run
          .catch(() => {})
          .then(() => {
            if (inflight === run) inflight = undefined;
          });
        return run;
      }

      /** Re-render without reading (used for locale switches). */
      function touch() {
        notify();
      }

      function start() {
        try {
          const stream = ctx.remote.$stream({
            name: 'account',
            open: (signal) => accountRemote.watch(signal),
            ended: () => new Error('account stream ended'),
          });
          streamDispose = () => stream.dispose();
          (async () => {
            for await (const frame of stream) {
              if (disposed) return;
              const view = frame.value;
              const wasSignedIn = state.view !== null && state.view.status === 'credential-stored';
              const isSignedIn = view !== null && view.status === 'credential-stored';
              publish({ view });
              if (!isSignedIn) publish({ phase: 'signed-out', balance: null, profile: null, failed: false });
              else if (!wasSignedIn || state.balance === null) refresh();
              frame.accept();
            }
          })().catch(() => {});
        } catch (_error) {
          /* no account namespace or no stream carrier: the poll below still reads the balance */
        }
        if (typeof setInterval === 'function') {
          pollTimer = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
          }, POLL_INTERVAL_MS);
        }
        if (typeof document !== 'undefined') {
          visibilityHandler = () => {
            if (document.visibilityState === 'visible') refresh();
          };
          document.addEventListener('visibilitychange', visibilityHandler);
        }
        refresh();
      }

      function stop() {
        disposed = true;
        generation += 1;
        if (pollTimer !== undefined && typeof clearInterval === 'function') clearInterval(pollTimer);
        pollTimer = undefined;
        if (visibilityHandler !== undefined && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', visibilityHandler);
        }
        visibilityHandler = undefined;
        if (streamDispose !== undefined) streamDispose();
        streamDispose = undefined;
        listeners.clear();
      }

      /** Consumption observed while the widget stayed open; null until a second reading exists. */
      function spentSinceOpen() {
        if (baseline === undefined || state.balance === null) return null;
        const current = totalsOf(state.balance.wallets);
        const parts = [];
        for (const [currency, total] of current) {
          const before = baseline.get(currency);
          if (before === undefined) continue;
          const delta = before - total;
          if (delta <= 0) continue;
          parts.push({ currency, text: `−${currencySymbol(currency)}${formatAmount(delta.toFixed(2))}` });
        }
        return parts.length === 0 ? null : parts;
      }

      return { get, subscribe, refresh, start, stop, touch, spentSinceOpen };
    }

    /** Wallet glyph; inherits the host's text color so it works in both themes. */
    function WalletGlyph({ size = 15 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M1.9 4.6c0-.83.67-1.5 1.5-1.5h8.2c.83 0 1.5.67 1.5 1.5v.4H3.4c-.83 0-1.5.67-1.5 1.5v5.4c0 .83.67 1.5 1.5 1.5h9.2c.83 0 1.5-.67 1.5-1.5V7.2c0-.83-.67-1.5-1.5-1.5H3.4',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 11.4, cy: 8.6, r: 1.05, fill: 'currentColor' }),
      );
    }

    /**
     * Select the main Session's live `tokenUsage` projection out of the root-scope sessions snapshot.
     * Returns the projection value itself, never a copy: a selector that builds a new object on every
     * call would re-render forever.
     * @param snapshot - root sessions snapshot.
     * @returns the wire `tokenUsage` value, or undefined when no main Session or no projection exists.
     */
    function selectMainTokenUsage(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return undefined;
      const rows = snapshot.byId;
      if (rows === null || typeof rows !== 'object') return undefined;
      for (const id of Object.keys(rows)) {
        const retained = rows[id]?.retainedBy?.mainView ?? 0;
        if (retained <= 0) continue;
        return snapshot.projectionsBySession?.[id]?.values?.tokenUsage;
      }
      return undefined;
    }

    /** One labelled value row inside the expanded card. */
    function StatRow({ label, value, tone }) {
      return h(
        'div',
        { className: 'dsh-auw-row' },
        h('span', { className: 'dsh-auw-rowLabel' }, label),
        h('span', { className: `dsh-auw-rowValue${tone === undefined ? '' : ` dsh-auw-${tone}`}` }, value),
      );
    }

    /** Plugin-owned global styles; rendered with the entry so unmounting removes them. */
    function Styles() {
      return h('style', null, CSS);
    }

    /**
     * Entry wrapper that binds the root-scope `useSessions` standard prop.
     * The hook is only reachable through the prop, so the wrapper exists as a separate component
     * whose hook order never changes, and a composition without sessions degrades to the account-only card.
     */
    function AccountUsageEntry(props) {
      if (typeof props.useSessions !== 'function') return h(AccountUsageView, { ...props, sessionTokens: undefined });
      return h(AccountUsageEntryWithSessions, props);
    }

    function AccountUsageEntryWithSessions(props) {
      const sessionTokens = props.useSessions(selectMainTokenUsage);
      return h(AccountUsageView, { ...props, sessionTokens });
    }

    function AccountUsageView(props) {
      const { usage, t, sessionTokens } = props;
      const [state, setState] = useState(usage.get());
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => usage.subscribe(() => setState(usage.get())), [usage]);

      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [open]);

      const onToggle = useCallback(() => setOpen((value) => !value), []);
      const onRefresh = useCallback(
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          usage.refresh();
        },
        [usage],
      );

      const signedIn = state.view !== null && state.view.status === 'credential-stored';
      const wallets = state.balance === null ? [] : walletRows(state.balance.wallets);
      const bonus = state.balance === null ? [] : walletRows(state.balance.bonus);
      const spent = usage.spentSinceOpen();
      const usageUrl = state.view !== null && state.view.links !== undefined ? state.view.links.usageUrl : undefined;

      // Collapsed summary: the first recharge wallet, else the first bonus wallet.
      const headline = wallets[0]?.text ?? bonus[0]?.text ?? null;
      const dotTone = state.failed ? 'failed' : state.phase === 'ready' ? 'ready' : 'idle';
      const pillLabel =
        state.phase === 'signed-out' || (!signedIn && headline === null)
          ? t('signedOut')
          : state.failed && headline === null
            ? t('failed')
            : t('balance');
      const pending = state.phase === 'loading' && headline === null;

      const pill = h(
        'button',
        {
          type: 'button',
          className: 'dsh-auw-pill',
          onClick: onToggle,
          'aria-expanded': open,
          'aria-label': open ? t('collapse') : t('expand'),
          title: t('title'),
        },
        h('span', { className: 'dsh-auw-glyph' }, h(WalletGlyph, null)),
        h(
          'span',
          { className: 'dsh-auw-pillText' },
          h('span', { className: 'dsh-auw-pillLabel' }, pending ? t('loading') : pillLabel),
        ),
        headline !== null
          ? h('span', { className: 'dsh-auw-pillAmount' }, headline)
          : pending
            ? h('span', { className: 'dsh-auw-skeleton dsh-auw-skeletonPill' })
            : null,
        h('span', { className: `dsh-auw-dot dsh-auw-dot-${dotTone}` }),
      );

      const card = h(
        'div',
        { className: 'dsh-auw-card', role: 'group', 'aria-label': t('title') },
        h(
          'div',
          { className: 'dsh-auw-head' },
          h(
            'div',
            { className: 'dsh-auw-headText' },
            h('span', { className: 'dsh-auw-title' }, t('title')),
            h(
              'span',
              { className: 'dsh-auw-subtitle' },
              state.profile !== null && state.profile.name !== null
                ? `${state.profile.name}${state.profile.contact === null ? '' : ` · ${state.profile.contact}`}`
                : signedIn
                  ? t('signedIn')
                  : t('signedOut'),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-auw-iconButton',
              onClick: onRefresh,
              'aria-label': t('refresh'),
              title: t('refresh'),
            },
            h(
              'svg',
              { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', {
                d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.8V5.4H10.4',
                stroke: 'currentColor',
                strokeWidth: '1.3',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-auw-iconButton',
              onClick: onToggle,
              'aria-label': t('collapse'),
              title: t('collapse'),
            },
            h(
              'svg',
              { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', {
                d: 'M4 6l4 4 4-4',
                stroke: 'currentColor',
                strokeWidth: '1.4',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-auw-body' },
          state.phase === 'loading' && state.balance === null
            ? h('div', { className: 'dsh-auw-skeleton dsh-auw-skeletonRow' })
            : null,
          state.phase === 'signed-out'
            ? h('p', { className: 'dsh-auw-hint' }, t('signedOutHint'))
            : null,
          state.phase === 'failed'
            ? h(
                'div',
                { className: 'dsh-auw-failure' },
                h('span', { className: 'dsh-auw-errorText' }, t('failed')),
                h(
                  'button',
                  { type: 'button', className: 'dsh-auw-retry', onClick: onRefresh },
                  t('retry'),
                ),
              )
            : null,
          wallets.map((wallet) =>
            h(StatRow, { key: `balance-${wallet.currency}`, label: t('balance'), value: wallet.text }),
          ),
          bonus.map((wallet) =>
            h(StatRow, { key: `bonus-${wallet.currency}`, label: t('bonus'), value: wallet.text }),
          ),
          spent !== null && spent.length > 0
            ? h(StatRow, {
                key: 'spent',
                label: t('spentSinceOpen'),
                value: spent.map((part) => part.text).join(' · '),
                tone: 'accent',
              })
            : null,
          sessionTokens !== undefined && sessionTokens !== null
            ? h(
                'div',
                { className: 'dsh-auw-section' },
                h('span', { className: 'dsh-auw-sectionTitle' }, t('sessionUsage')),
                h(StatRow, { label: t('tokensIn'), value: formatTokens(sessionTokens.uncachedInputTokens) }),
                h(StatRow, { label: t('tokensOut'), value: formatTokens(sessionTokens.outputTokens) }),
                sessionTokens.cacheReadTokens > 0
                  ? h(StatRow, { label: t('cacheRead'), value: formatTokens(sessionTokens.cacheReadTokens) })
                  : null,
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-auw-foot' },
          h(
            'span',
            { className: 'dsh-auw-updated' },
            state.updatedAt === 0 ? t('updatedNever') : t('updated', { time: formatClock(state.updatedAt) }),
          ),
          usageUrl === undefined
            ? null
            : h(
                'a',
                { className: 'dsh-auw-link', href: usageUrl, target: '_blank', rel: LINK_REL },
                t('openUsage'),
              ),
        ),
      );

      return h('div', { className: 'dsh-auw-root', ref: rootRef }, h(Styles, { key: 'styles' }), pill, open ? card : null);
    }

    const CSS = `
.dsh-auw-root{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-size:13px;line-height:1.45}
.dsh-auw-root>*{pointer-events:auto}
.dsh-auw-pill{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.12));cursor:pointer;font:inherit;font-size:13px;line-height:1;transition:background .15s ease,border-color .15s ease}
.dsh-auw-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-auw-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-auw-glyph{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dsh-auw-pillLabel{color:var(--dsw-alias-label-tertiary)}
.dsh-auw-pillAmount{font-weight:500;font-variant-numeric:tabular-nums}
.dsh-auw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsh-auw-dot-ready{background:var(--dsw-alias-state-success-primary)}
.dsh-auw-dot-failed{background:var(--dsw-alias-state-error-primary)}
.dsh-auw-card{box-sizing:border-box;width:288px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.16));color:var(--dsw-alias-label-primary);overflow:hidden}
.dsh-auw-head{display:flex;align-items:flex-start;gap:4px;padding:12px 12px 8px 14px}
.dsh-auw-headText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-auw-title{font-size:13px;font-weight:500}
.dsh-auw-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-auw-iconButton{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dsh-auw-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-auw-body{display:flex;flex-direction:column;gap:6px;padding:2px 14px 10px}
.dsh-auw-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsh-auw-rowLabel{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-auw-rowValue{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums}
.dsh-auw-accent{color:var(--dsw-alias-state-warn-primary)}
.dsh-auw-section{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-auw-sectionTitle{font-size:11px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsh-auw-section .dsh-auw-rowValue{font-size:13px;font-weight:400}
.dsh-auw-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-auw-failure{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-auw-errorText{font-size:12px;color:var(--dsw-alias-label-error)}
.dsh-auw-retry{border:0;background:transparent;padding:0;color:var(--dsw-alias-link);font:inherit;font-size:12px;cursor:pointer}
.dsh-auw-retry:hover{text-decoration:underline}
.dsh-auw-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px 10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-auw-updated{font-size:11px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums}
.dsh-auw-link{font-size:12px;color:var(--dsw-alias-link);text-decoration:none}
.dsh-auw-link:hover{text-decoration:underline}
.dsh-auw-skeleton{display:block;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-interactive-bg-hover))}
.dsh-auw-skeletonPill{display:inline-block;vertical-align:middle;width:56px;height:10px}
.dsh-auw-skeletonRow{height:16px;margin:4px 0}
@media (prefers-reduced-motion: reduce){.dsh-auw-pill{transition:none}}
`;

    return {
      // `remote.account` keeps the entry pending — never throwing — in a profile whose composition
      // mounts no account namespace, exactly as the shipped account settings page declares it.
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        const accountRemote = ctx.remote.account;

        ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'account-usage: dictionaries');
        const t = ctx.locale.bind(NAMESPACE);
        const usage = createUsageStore(accountRemote, ctx);

        ctx.effect(() => {
          usage.start();
          return () => usage.stop();
        }, 'account-usage: polling and account stream');

        if (typeof ctx.locale.subscribe === 'function') {
          ctx.effect(() => ctx.locale.subscribe(() => usage.touch()), 'account-usage: locale changes');
        }

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: ENTRY_ID, order: 40, label: () => t('title'), locale: NAMESPACE, inject: () => ({ usage, t }) },
            AccountUsageEntry,
          ),
        );
      },
    };
  },
});
