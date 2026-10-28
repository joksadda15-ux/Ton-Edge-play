// FILE PATH: lib/tonPayout.js
// (GitHub repo te ei path e file ta rakhbe: lib/tonPayout.js)
// Ported from NEWTUBE. Needs the 3 payout env vars on Render (see header below); OFF unless TON_PAYOUT_ENABLED=1.
// lib/tonPayout.js — AUTOMATIC USDT payout (USDT-on-TON) for Tonkeeper withdrawals. (15 Oct 2026)
//
// When the admin taps ✅ Approve on a Tonkeeper withdrawal, api/bot.js calls sendUsdtPayout() and the
// money goes from the payout wallet (the one whose 24-word recovery phrase is in Render) straight to the user.
//
// Render Environment Variables (the service):
//   TON_PAYOUT_MNEMONIC        24 recovery words, separated by single spaces   (REQUIRED, keep it Sensitive)
//   TON_PAYOUT_ENABLED         "1" turns auto-payout on                        (REQUIRED, anything else = manual)
//   TON_PAYOUT_WALLET_VERSION  "v5r1" (default, current Tonkeeper) or "v4r2"   (must match the wallet!)
//   TON_PAYOUT_MAX_USD         safety cap PER payout in dollars, default 20     (optional)
//   TON_PAYOUT_DAILY_MAX_USD   safety cap for ALL payouts in 24h (this bot), 0/empty = off (optional, checked in api/bot.js)
//   TONCENTER_API_KEY          free key from @tonapibot — strongly recommended (optional)
//   TON_USDT_MASTER            USDT jetton master, default = official USDT     (optional)
//
// Safety design:
//   • "safeToRetry" errors (nothing was broadcast) → the admin may press Approve again.
//   • Anything that goes wrong AFTER the transfer was handed to the network is "unknown": the caller must NOT retry
//     automatically (double payment risk) — the admin checks the wallet and approves manually.

import { TonClient, WalletContractV4, WalletContractV5R1, internal, toNano, beginCell, Address, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

const USDT_MASTER_DEFAULT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'; // official USDT on TON (6 decimals)
const USDT_DECIMALS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function payoutEnabled() {
    return process.env.TON_PAYOUT_ENABLED === '1' && !!process.env.TON_PAYOUT_MNEMONIC;
}
export function payoutMaxUsd() {
    const v = Number(process.env.TON_PAYOUT_MAX_USD);
    return Number.isFinite(v) && v > 0 ? v : 20;
}

function fail(message, safeToRetry = true) {
    const e = new Error(message);
    e.safeToRetry = safeToRetry;
    return e;
}

// TonCenter's keyless endpoint is limited to ~1 request/second, so retry politely on HTTP 429.
async function rpc(fn) {
    let last;
    for (let i = 0; i < 5; i++) {
        try { return await fn(); } catch (e) {
            last = e;
            const msg = String(e?.message || e);
            if (!/429|rate|too many/i.test(msg)) throw e;
            await sleep(1300);
        }
    }
    throw last;
}

async function loadWallet() {
    const words = (process.env.TON_PAYOUT_MNEMONIC || '').trim().split(/\s+/).filter(Boolean);
    if (words.length !== 24) throw fail('TON_PAYOUT_MNEMONIC must contain exactly 24 words.');
    let keyPair;
    try { keyPair = await mnemonicToPrivateKey(words); } catch { throw fail('TON_PAYOUT_MNEMONIC is not a valid recovery phrase.'); }
    const version = (process.env.TON_PAYOUT_WALLET_VERSION || 'v5r1').toLowerCase();
    const contract = version === 'v4r2'
        ? WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
        : WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    const client = new TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY || undefined,
    });
    return { keyPair, contract, client, version, wallet: client.open(contract) };
}

async function getJettonWalletAddress(client, owner) {
    const master = Address.parse(process.env.TON_USDT_MASTER || USDT_MASTER_DEFAULT);
    const r = await rpc(() => client.runMethod(master, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]));
    return r.stack.readAddress();
}
async function getJettonBalance(client, jettonWallet) {
    try {
        const r = await rpc(() => client.runMethod(jettonWallet, 'get_wallet_data'));
        return r.stack.readBigNumber();
    } catch { return 0n; } // jetton wallet not deployed yet = no USDT
}

// For the admin "💳 Payout Wallet" check: shows which address the phrase controls + balances.
export async function getPayoutWalletInfo() {
    const { contract, client, version } = await loadWallet();
    const addr = contract.address;
    const tonBal = await rpc(() => client.getBalance(addr));
    const jw = await getJettonWalletAddress(client, addr);
    const usdt = await getJettonBalance(client, jw);
    return {
        version,
        address: addr.toString({ bounceable: false, urlSafe: true }),
        ton: Number(tonBal) / 1e9,
        usdt: Number(usdt) / 10 ** USDT_DECIMALS,
    };
}

// Sends `amountUsd` USDT to `toAddress`. Resolves { confirmed, seqno, txHash } — confirmed=false means the network accepted the
// message but the wallet's seqno had not moved yet when we stopped waiting (treat as "unknown", never auto-retry).
export async function sendUsdtPayout({ toAddress, amountUsd }) {
    if (!payoutEnabled()) throw fail('Auto-payout is not enabled.');
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw fail('Invalid payout amount.');
    if (amountUsd > payoutMaxUsd()) throw fail(`Amount $${amountUsd.toFixed(4)} is above the safety cap of $${payoutMaxUsd()} (TON_PAYOUT_MAX_USD). Approve manually or raise the cap.`);

    let dest;
    try { dest = Address.parse(String(toAddress).trim()); } catch { throw fail('The user address is not a valid TON address.'); }

    const { keyPair, contract, client, wallet } = await loadWallet();
    const microUsdt = BigInt(Math.round(amountUsd * 10 ** USDT_DECIMALS));
    if (microUsdt <= 0n) throw fail('Payout amount rounds to zero.');

    // Pre-flight (nothing sent yet → all of these are safe to retry once fixed)
    const tonBal = await rpc(() => client.getBalance(contract.address));
    if (tonBal < toNano('0.08')) throw fail(`Payout wallet has too little TON for fees (${(Number(tonBal) / 1e9).toFixed(3)} TON). Add at least 0.2 TON.`);
    const jettonWallet = await getJettonWalletAddress(client, contract.address);
    const usdtBal = await getJettonBalance(client, jettonWallet);
    if (usdtBal < microUsdt) throw fail(`Payout wallet has only ${(Number(usdtBal) / 1e6).toFixed(4)} USDT, needs ${amountUsd.toFixed(4)}.`);
    const seqno = await rpc(() => wallet.getSeqno());

    const body = beginCell()
        .storeUint(0x0f8a7ea5, 32)                 // jetton transfer
        .storeUint(BigInt(Date.now()), 64)         // query id
        .storeCoins(microUsdt)
        .storeAddress(dest)                        // new owner
        .storeAddress(contract.address)            // excess TON comes back to the payout wallet
        .storeBit(false)                           // no custom payload
        .storeCoins(1n)                            // forward 1 nanoTON so the receiver gets a notification (+comment)
        .storeBit(true)
        .storeRef(beginCell().storeUint(0, 32).storeStringTail('NEWTUBE withdrawal').endCell())
        .endCell();

    // ── point of no return ──
    // HTTP 429 = TonCenter was too busy and REFUSED the message (nothing broadcast). Retrying the SAME seqno is safe: the wallet
    // accepts one message per seqno, so a retry can never pay twice. Any other error after sending = unknown (never auto-retry).
    let sent = false;
    for (let i = 0; i < 5 && !sent; i++) {
        try {
            await wallet.sendTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
                messages: [internal({ to: jettonWallet, value: toNano('0.05'), bounce: true, body })],
            });
            sent = true;
        } catch (e) {
            const msg = String(e?.message || e);
            if (/429|too many|rate limit/i.test(msg)) { await sleep(1500 + i * 800); continue; }
            throw fail('Transfer was submitted but the network answer was unclear: ' + msg, false);
        }
    }
    if (!sent) throw fail('TonCenter is too busy (error 429) and refused the transfer. NOTHING was sent. Add TONCENTER_API_KEY on Render (free key from @tonapibot), wait a minute, then tap Retry.', true);

    // Wait (max ~16s) until OUR transfer shows up as an outgoing message of the payout wallet. We match the exact message body
    // (it contains a unique query id), NOT just "seqno moved": the same wallet also pays the Fruit bot, and the other bot's
    // transfer would move the seqno too — that must never be mistaken for ours.
    for (let i = 0; i < 8; i++) {
        await sleep(2000);
        try {
            const txs = await rpc(() => client.getTransactions(contract.address, { limit: 8 }));
            for (const tx of txs) {
                for (const m of tx.outMessages.values()) {
                    if (m.body && m.body.hash().equals(body.hash())) return { confirmed: true, seqno, txHash: tx.hash().toString('hex') };
                }
            }
        } catch { /* keep waiting */ }
    }
    return { confirmed: false, seqno };
}
