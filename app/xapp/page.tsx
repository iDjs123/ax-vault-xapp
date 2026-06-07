"use client"

import { useEffect, useRef, useState, useMemo } from "react"

type Toast = { type: "success" | "error"; msg: string }

type Position = {
  id: string
  asset: "XRP" | "RLUSD"
  amount: number
  lockMonths: number
  apy: number
  startDate: string
  endDate: string | null
  status: "active" | "withdrawn"
  txid: string
}

type TxRecord = {
  id: string
  type: "deposit" | "withdrawal"
  asset: string
  amount: number
  txid: string
  ts: string
  status: "confirmed" | "pending"
  positionId?: string
}

type WithdrawalRequest = {
  id: string
  positionId: string
  asset: string
  amount: number
  maxAmount: number
  status: "pending" | "confirmed" | "cancelled"
  txid?: string
  ts: string
  wallet: string
}

type Loan = {
  id: string
  wallet: string
  collateral: number
  loanAmount: number
  interestRate: number
  startDate: string
  status: string
  daysActive: number
  interestAccrued: number
  totalDue: number
  canRepay: boolean
}

const XAMAN_PAYLOAD_TIMEOUT = 5 * 60

// APY real usado internamente para calcular intereses (independiente del APY mostrado)
const REAL_APY: Record<"XRP" | "RLUSD", number> = { XRP: 3, RLUSD: 6 }

// APY mostrado al usuario por asset y período (marketing / tiers)
const DISPLAYED_APY: Record<"XRP" | "RLUSD", Record<number, number>> = {
  XRP:   { 0: 1.0, 1: 1.5, 3: 2.0, 6: 2.5,  12: 3.0 },
  RLUSD: { 0: 3.0, 1: 3.5, 3: 4.0, 6: 5.0,  12: 6.0 },
}

// Etiqueta APY mostrada en UI (12 meses muestra rango atractivo)
const APY_LABEL: Record<"XRP" | "RLUSD", Record<number, string>> = {
  XRP:   { 0: "1%", 1: "1.5%", 3: "2%", 6: "2.5%", 12: "3-4.5%" },
  RLUSD: { 0: "3%", 1: "3.5%", 3: "4%", 6: "5%",   12: "6-7%" },
}

// Rango APY mostrado en el selector de asset
const ASSET_APY_RANGE: Record<"XRP" | "RLUSD", string> = {
  XRP:   "1% - 4.5% APY",
  RLUSD: "3% - 7% APY",
}

const FROZEN_BALANCES_KEY = "xapp_frozen_balances"
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function getDisplayedApy(asset: "XRP" | "RLUSD", lockMonths: number): number {
  return DISPLAYED_APY[asset][lockMonths] ?? DISPLAYED_APY[asset][0]
}

function getApyLabel(asset: "XRP" | "RLUSD", lockMonths: number): string {
  return APY_LABEL[asset][lockMonths] ?? APY_LABEL[asset][0]
}

const LOCK_OPTIONS = [
  { months: 0,  label: "Flexible" },
  { months: 1,  label: "1 month"  },
  { months: 3,  label: "3 months" },
  { months: 6,  label: "6 months" },
  { months: 12, label: "12 months"},
]

function calcInterest(amount: number, apy: number, startDate: string): number {
  const days = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
  return amount * (apy / 100) * (days / 365.25)
}

function calcLoanInterest(amount: number, rate: number, startDate: string): number {
  const days = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
  return amount * (rate / 100) * (days / 365.25)
}

function calcEndDate(startDate: string, months: number): string | null {
  if (months === 0) return null
  const d = new Date(startDate)
  d.setMonth(d.getMonth() + months)
  return d.toISOString()
}

function canWithdraw(position: Position): boolean {
  if (position.lockMonths === 0) return true
  if (!position.endDate) return true
  return new Date() >= new Date(position.endDate)
}

function daysLeft(endDate: string | null): number {
  if (!endDate) return 0
  const diff = new Date(endDate).getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
}

function maxWithdrawable(position: Position): number {
  return position.amount + calcInterest(position.amount, REAL_APY[position.asset], position.startDate)
}

function hasRealFunds(position: Position): boolean {
  return position.status === "active" && position.amount > 0 && !!position.txid
}

function hasPendingWithdrawal(positionId: string, requests: WithdrawalRequest[]): boolean {
  return requests.some((r) => r.positionId === positionId && r.status === "pending")
}

function hasPendingWithdrawalForAsset(asset: string, requests: WithdrawalRequest[]): boolean {
  return requests.some((r) => r.asset === asset && r.status === "pending")
}

function getAvailableAssets(positions: Position[]): ("XRP" | "RLUSD")[] {
  const assets = new Set<"XRP" | "RLUSD">()
  for (const p of positions) {
    if (hasRealFunds(p)) assets.add(p.asset)
  }
  return Array.from(assets)
}

function getAvailableBalance(asset: "XRP" | "RLUSD", positions: Position[]): number {
  return positions
    .filter((p) => p.asset === asset && p.status === "active" && hasRealFunds(p) && canWithdraw(p))
    .reduce((acc, p) => acc + maxWithdrawable(p), 0)
}

function getLockedPositionsForAsset(asset: "XRP" | "RLUSD", positions: Position[]): Position[] {
  return positions.filter(
    (p) => p.asset === asset && p.status === "active" && hasRealFunds(p) && !canWithdraw(p)
  )
}

function canWithdrawPosition(position: Position, requests: WithdrawalRequest[]): boolean {
  if (!hasRealFunds(position)) return false
  if (!canWithdraw(position)) return false
  if (hasPendingWithdrawal(position.id, requests)) return false
  return true
}

type Tab = "deposit" | "positions" | "withdraw" | "loans" | "history"

const API_KEY = "588cd466-956f-4a68-a451-456cd1cfa646"

export default function XApp() {
  const xummRef = useRef<any>(null)
  const [isXapp, setIsXapp] = useState(false)
  const [xummReady, setXummReady] = useState(false)
  const [isDark, setIsDark] = useState(false)

  const [wallet, setWallet] = useState<string | null>(null)
  const [asset, setAsset] = useState<"XRP" | "RLUSD">("XRP")
  const [amount, setAmount] = useState("")
  const [withdrawAsset, setWithdrawAsset] = useState<"XRP" | "RLUSD">("XRP")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [lockMonths, setLockMonths] = useState(0)
  const [qr, setQr] = useState<string | null>(null)
  const [deeplink, setDeeplink] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [connectUuid, setConnectUuid] = useState<string | null>(null)
  const [depositUuid, setDepositUuid] = useState<string | null>(null)
  const [withdrawUuid, setWithdrawUuid] = useState<string | null>(null)
  const [withdrawModal, setWithdrawModal] = useState<{ asset: string; amount: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [serverWithdrawals, setServerWithdrawals] = useState<TxRecord[]>([])
  const [refreshPositionsTick, setRefreshPositionsTick] = useState(0)
  const prevCompletedIdsRef = useRef<Set<string>>(new Set())
  const [txHistory, setTxHistory] = useState<TxRecord[]>([])
  const [withdrawalRequests, setWithdrawalRequests] = useState<WithdrawalRequest[]>([])
  const [loans, setLoans] = useState<Loan[]>([])
  const [loanCollateral, setLoanCollateral] = useState("")
  const pendingWithdrawPositionId = useRef<string | null>(null)
  const pendingWithdrawData = useRef<{
    requestId: string; positionId: string
    asset: "XRP" | "RLUSD"; amount: number; maxAmount: number; ts: string
  } | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>("deposit")
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [walletBalance, setWalletBalance] = useState<{ XRP: number; RLUSD: number }>({ XRP: 0, RLUSD: 0 })
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [frozenBalances, setFrozenBalances] = useState<Record<string, { interest: number; shownAt: number }>>({})

  // ── Persistent storage: Xumm userstore (xApp) + localStorage fallback ───
  // Escribe en userstore si está disponible; cae a localStorage si no.
  async function storeSet(key: string, value: string): Promise<void> {
    try {
      if ((xummRef.current as any)?.userstore) {
        await (xummRef.current as any).userstore.set(key, value)
        return
      }
    } catch {}
    try { localStorage.setItem(key, value) } catch {}
  }

  async function storeGet(key: string): Promise<string | null> {
    try {
      if ((xummRef.current as any)?.userstore) {
        const res = await (xummRef.current as any).userstore.get(key)
        const data = res?.data
        if (data != null && data !== "") return String(data)
      }
    } catch {}
    try { return localStorage.getItem(key) } catch { return null }
  }

  async function storeRemove(key: string): Promise<void> {
    try {
      if ((xummRef.current as any)?.userstore) {
        await (xummRef.current as any).userstore.set(key, "")
      }
    } catch {}
    try { localStorage.removeItem(key) } catch {}
  }

  // ── Inicializar Xumm SDK + auto-connect ─────────────────────────────────
  useEffect(() => {
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"

    async function autoConnect() {
      try {
        const { Xumm } = await import("xumm")
        const xumm = new Xumm(API_KEY)
        xummRef.current = xumm

        // Esperar a que el SDK esté listo
        await new Promise<void>((resolve) => xumm.on("ready", () => resolve()))

        // Leer tema de Xaman (LIGHT | DARK) y aplicarlo
        try {
          const style = await xumm.user.style
          setIsDark(String(style).toUpperCase() === "DARK")
        } catch {}


        if (xumm.runtime?.xapp) {
          setIsXapp(true)
          // Intentar obtener cuenta directamente
          let account = await xumm.user.account
          if (!account) {
            // Fallback: authorize() dispara el consentimiento de Xaman
            try {
              await xumm.authorize()
              account = await xumm.user.account
            } catch {}
          }
          if (account) {
            storeSet("xaman_wallet", account).catch(() => {})
            setWallet(account)
            setXummReady(true)
            return
          }
          // Último recurso: listener "retrieved"
          xumm.user.on("retrieved", async () => {
            const acc = await xumm.user.account
            if (acc) {
              storeSet("xaman_wallet", acc).catch(() => {})
              setWallet(acc)
            }
            setXummReady(true)
          })
        } else {
          // Browser normal: recuperar sesión guardada
          const saved = await storeGet("xaman_wallet")
          if (saved) setWallet(saved)
          setXummReady(true)
        }
      } catch {
        const saved = await storeGet("xaman_wallet")
        if (saved) setWallet(saved)
        setXummReady(true)
      }
    }

    autoConnect()
  }, [])

  // ── Aplicar tema de Xaman vía CSS variables ──────────────────────────────
  useEffect(() => {
    const root = document.documentElement
    if (isDark) {
      root.setAttribute("data-xapp-theme", "dark")
      root.style.setProperty("--xapp-bg", "#1a1a2e")
      root.style.setProperty("--xapp-text", "#f1f1f5")
      root.style.setProperty("--xapp-card", "#2a2a3e")
    } else {
      root.removeAttribute("data-xapp-theme")
      root.style.setProperty("--xapp-bg", "#ffffff")
      root.style.setProperty("--xapp-text", "#1a1a2e")
      root.style.setProperty("--xapp-card", "#f8f8f8")
    }
    // Limpiar atributo al desmontar (no afectar otras páginas)
    return () => { root.removeAttribute("data-xapp-theme") }
  }, [isDark])

  // ── Cargar estado persistido ─────────────────────────────────────────────
  useEffect(() => {
    async function loadStored() {
      const p = await storeGet("xaman_positions")
      if (p) try { setPositions(JSON.parse(p)) } catch {}
      const h = await storeGet("xaman_history")
      if (h) try { setTxHistory(JSON.parse(h)) } catch {}
      const wr = await storeGet("xaman_withdrawal_requests")
      if (wr) try { setWithdrawalRequests(JSON.parse(wr)) } catch {}
    }
    loadStored()
  }, [])

  // ── Balance XRPL on-chain (account_info + account_lines) ────────────────
  useEffect(() => {
    if (!wallet) return
    async function fetchWalletBalance() {
      setBalanceLoading(true)
      try {
        const res = await fetch(`/api/xaman/xrpl-balance?wallet=${wallet}`)
        const data = await res.json()
        setWalletBalance({
          XRP: Number(data.xrp ?? 0),
          RLUSD: Number(data.rlusd ?? 0),
        })
      } catch {}
      setBalanceLoading(false)
    }
    fetchWalletBalance()
    const iv = setInterval(fetchWalletBalance, 15000)
    return () => clearInterval(iv)
  }, [wallet])

  // ── Balance congelado: actualiza interés visible cada 7 días ─────────────
  useEffect(() => {
    if (positions.length === 0) return
    async function updateFrozen() {
      const now = Date.now()
      let stored: Record<string, { interest: number; shownAt: number }> = {}
      try { stored = JSON.parse((await storeGet(FROZEN_BALANCES_KEY)) ?? "{}") } catch {}
      const updated = { ...stored }
      let changed = false
      for (const pos of positions) {
        if (pos.status !== "active") continue
        const entry = updated[pos.id]
        if (!entry || now - entry.shownAt >= SEVEN_DAYS_MS) {
          updated[pos.id] = {
            interest: calcInterest(pos.amount, REAL_APY[pos.asset], pos.startDate),
            shownAt: now,
          }
          changed = true
        }
      }
      if (changed) {
        setFrozenBalances(updated)
        storeSet(FROZEN_BALANCES_KEY, JSON.stringify(updated)).catch(() => {})
      } else {
        setFrozenBalances(stored)
      }
    }
    updateFrozen()
  }, [positions])

  // ── Polling de retiros completados cada 30s — refresca posiciones ────────
  useEffect(() => {
    if (!wallet) return

    async function pollWithdraws() {
      try {
        const res = await fetch("/api/xaman/withdraw/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (!data.withdraws?.length) return

        const completed: TxRecord[] = []
        for (const w of data.withdraws) {
          if (w.status === "completed") {
            completed.push({
              id: w.id,
              type: "withdrawal",
              asset: w.asset,
              amount: Number(w.amount),
              txid: w.txHash ?? "",
              ts: new Date(w.completedAt ?? w.createdAt).toLocaleString(),
              status: "confirmed",
            })
          }
        }

        setServerWithdrawals(completed)

        // Si hay nuevos retiros completados → forzar recarga inmediata de posiciones
        const hasNewCompletions = completed.some((c) => !prevCompletedIdsRef.current.has(c.id))
        prevCompletedIdsRef.current = new Set(completed.map((c) => c.id))
        if (hasNewCompletions) {
          setRefreshPositionsTick((t) => t + 1)

          // Sincronizar estado "confirmed" en withdrawalRequests y txHistory
          const completedMap = new Map(completed.map((c) => [c.id, c]))
          setWithdrawalRequests((prev) => {
            const updated = prev.map((req) =>
              completedMap.has(req.id) ? { ...req, status: "confirmed" as const } : req
            )
            storeSet("xaman_withdrawal_requests", JSON.stringify(updated)).catch(() => {})
            return updated
          })
          setTxHistory((prev) => {
            const updated = prev.map((tx) => {
              if (tx.type !== "withdrawal") return tx
              const done = completedMap.get(tx.id)
              if (!done) return tx
              return { ...tx, status: "confirmed" as const, txid: done.txid || tx.txid }
            })
            storeSet("xaman_history", JSON.stringify(updated)).catch(() => {})
            return updated
          })
        }
      } catch {}
    }

    pollWithdraws()
    const iv = setInterval(pollWithdraws, 30000)
    return () => clearInterval(iv)
  }, [wallet])

  // ── Cargar datos de DB cuando wallet está lista ──────────────────────────
  useEffect(() => {
    if (!wallet) return

    async function loadFromDB() {
      try {
        const res = await fetch(`/api/xaman/positions?wallet=${wallet}`)
        if (!res.ok) return
        const data = await res.json()

        // Fix 3: SIEMPRE actualizar positions — incluso si es [] (retiros completados)
        setPositions(
          (data.deposits ?? []).map((d: any) => ({
            id: d.id,
            asset: d.asset,
            amount: Number(d.amount),
            lockMonths: d.lockMonths,
            apy: Number(d.apy),
            startDate: d.startDate,
            endDate: d.endDate,
            status: d.status,
            txid: d.txid ?? "",
          }))
        )

        // Historial de depósitos desde DB (todos los estados, incluyendo withdrawn)
        if (data.depositHistory) {
          const serverDepositEntries: TxRecord[] = data.depositHistory.map((d: any) => ({
            id: d.id,
            type: "deposit" as const,
            asset: d.asset,
            amount: Number(d.amount),
            txid: d.txid ?? "",
            ts: new Date(d.createdAt).toLocaleString(),
            status: "confirmed" as const,
          }))
          setTxHistory((prev) => {
            // Reemplazar entradas de depósito con las del servidor; mantener retiros locales
            const prevWithdrawals = prev.filter((tx) => tx.type !== "deposit")
            return [...serverDepositEntries, ...prevWithdrawals]
          })
        }

        // Historial de retiros desde DB (fusionar con depósitos)
        if (data.withdrawals) {
          const serverWithdrawEntries: TxRecord[] = data.withdrawals.map((w: any) => ({
            id: w.id,
            type: "withdrawal" as const,
            asset: w.asset,
            amount: Number(w.total ?? w.amount),
            txid: w.txid ?? "",
            ts: new Date(w.requestedAt ?? w.createdAt).toLocaleString(),
            status: (w.status === "completed" ? "confirmed" : "pending") as "confirmed" | "pending",
          }))
          setTxHistory((prev) => {
            const prevDeposits = prev.filter((tx) => tx.type !== "withdrawal")
            return [...prevDeposits, ...serverWithdrawEntries]
          })
        }
        if (data.loans) {
          setLoans(
            data.loans.map((l: any) => {
              const daysActive = Math.floor(
                (Date.now() - new Date(l.createdAt).getTime()) / (1000 * 60 * 60 * 24)
              )
              const interestAccrued = calcLoanInterest(
                Number(l.loanAmount),
                Number(l.interestRate),
                l.createdAt
              )
              return {
                id: l.id,
                wallet: l.wallet,
                collateral: Number(l.collateral),
                loanAmount: Number(l.loanAmount),
                interestRate: Number(l.interestRate),
                startDate: l.createdAt,
                status: l.status,
                daysActive,
                interestAccrued,
                totalDue: Number(l.loanAmount) + interestAccrued,
                canRepay: daysActive >= 30,
              }
            })
          )
        }
      } catch (err) {
        console.error("xapp: error loading from DB:", err)
      }
    }

    loadFromDB()
    const iv = setInterval(loadFromDB, 10000)
    return () => clearInterval(iv)
  }, [wallet, refreshPositionsTick])

  // ── Helpers ───────────────────────────────────────────────────────────────
  function save(newPositions: Position[], newHistory: TxRecord[]) {
    setPositions(newPositions)
    setTxHistory(newHistory)
    storeSet("xaman_positions", JSON.stringify(newPositions)).catch(() => {})
    storeSet("xaman_history", JSON.stringify(newHistory)).catch(() => {})
  }

  function saveWithdrawalRequests(requests: WithdrawalRequest[]) {
    setWithdrawalRequests(requests)
    storeSet("xaman_withdrawal_requests", JSON.stringify(requests)).catch(() => {})
  }

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg })
    setTimeout(() => setToast(null), 3500)
  }

  function closeModal() {
    setShowModal(false)
    setQr(null)
    setDeeplink(null)
    setConnectUuid(null)
    setDepositUuid(null)
    setWithdrawUuid(null)
    setWithdrawModal(null)
    pendingWithdrawPositionId.current = null
    setCountdown(null)
    if (timerRef.current) clearInterval(timerRef.current)
  }

  function startCountdown() {
    setCountdown(XAMAN_PAYLOAD_TIMEOUT)
    timerRef.current = setInterval(() => {
      setCountdown((s) => {
        if (s === null || s <= 1) {
          clearInterval(timerRef.current!)
          closeModal()
          showToast("error", "QR expired — try again")
          return null
        }
        return s - 1
      })
    }, 1000)
  }

  // ── Sign request: popup nativo en xApp, QR modal en browser ────────────
  function openSignRequest(uuid: string, qrUrl: string, dl: string) {
    if (isXapp && xummRef.current?.xapp) {
      xummRef.current.xapp.openSignRequest({ uuid })
      // El resultado llega via polling en los useEffect de depositUuid/withdrawUuid
    } else {
      setQr(qrUrl)
      setDeeplink(dl)
      setShowModal(true)
      startCountdown()
    }
  }

  async function cancelWithdrawal(id: string) {
    // Actualizar localStorage inmediatamente para feedback instantáneo
    const updated = withdrawalRequests.map((r) =>
      r.id === id && r.status === "pending" ? { ...r, status: "cancelled" as const } : r
    )
    saveWithdrawalRequests(updated)
    showToast("success", "Withdrawal cancelled")
    // Sincronizar con DB (no bloqueante)
    fetch("/api/xaman/withdraw/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, wallet }),
    }).catch(() => {})
  }

  function disconnect() {
    storeRemove("xaman_wallet").catch(() => {})
    setWallet(null)
  }

  function getFrozenInterest(pos: Position): number {
    return frozenBalances[pos.id]?.interest ?? calcInterest(pos.amount, REAL_APY[pos.asset], pos.startDate)
  }

  function getDaysUntilUpdate(posId: string): number {
    const entry = frozenBalances[posId]
    if (!entry) return 0
    const remaining = entry.shownAt + SEVEN_DAYS_MS - Date.now()
    return Math.max(0, Math.ceil(remaining / (1000 * 60 * 60 * 24)))
  }

  // ── Abrir links externos: dentro de xApp usa openBrowser(), fuera usa window.open ──
  function openBrowser(url: string) {
    if (isXapp && xummRef.current) {
      xummRef.current.xapp?.openBrowser({ url })
    } else {
      window.open(url, "_blank", "noopener,noreferrer")
    }
  }

  // ── Conexión de wallet ───────────────────────────────────────────────────
  async function connectWallet() {
    setLoading(true)
    try {
      const { Xumm } = await import("xumm")
      const xumm = new Xumm(API_KEY)

      if (xumm.runtime?.xapp) {
        // Dentro de Xaman: authorize() dispara el popup nativo
        await xumm.authorize()
        const account = await xumm.user.account
        if (account) {
          storeSet("xaman_wallet", account).catch(() => {})
          setWallet(account)
          showToast("success", "Wallet connected ✓")
        } else {
          showToast("error", "Could not get account")
        }
      } else {
        // Fuera de Xaman: QR flow via /api/xaman/connect
        const res = await fetch("/api/xaman/connect")
        const data = await res.json()
        if (!data.uuid) throw new Error("No UUID")
        setConnectUuid(data.uuid)
        setQr(data.qr)
        setDeeplink(data.deeplink)
        setShowModal(true)
        startCountdown()
      }
    } catch (e: any) {
      showToast("error", e?.message ?? "Error connecting")
    } finally {
      setLoading(false)
    }
  }

  async function deposit() {
    if (!wallet) return showToast("error", "Connect your wallet first")
    const amt = Number(amount)
    if (!amount || amt <= 0) return showToast("error", "Enter a valid amount")
    if (!balanceLoading && walletBalance[asset] > 0 && amt > walletBalance[asset] + 1e-9)
      return showToast("error", `Insufficient balance — available: ${walletBalance[asset].toFixed(4)} ${asset}`)
    setLoading(true)
    try {
      const res = await fetch("/api/xaman/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, amount, asset, lockMonths }),
      })
      const data = await res.json()
      if (!data.uuid) throw new Error("No UUID")
      setDepositUuid(data.uuid)
      openSignRequest(data.uuid, data.qr, data.deeplink)
    } catch {
      showToast("error", "Error creating deposit")
    } finally {
      setLoading(false)
    }
  }

  async function requestLoan() {
    if (!wallet) return showToast("error", "Connect your wallet first")
    if (!loanCollateral || Number(loanCollateral) <= 0)
      return showToast("error", "Enter collateral amount")
    const termsCheckbox = document.getElementById("loan-terms-xapp") as HTMLInputElement
    if (!termsCheckbox?.checked) return showToast("error", "Accept the loan terms")
    if (Number(loanCollateral) > rlusdVaultBalance + 1e-9)
      return showToast("error", `Collateral exceeds your RLUSD in vault (${rlusdVaultBalance.toFixed(4)})`)

    const collateral = Number(loanCollateral)
    const loanAmount = collateral * 0.75
    setLoading(true)
    try {
      const res = await fetch("/api/xaman/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          amount: collateral,
          asset: "RLUSD",
          lockMonths: 0,
          isLoan: true,
          loanAmount,
        }),
      })
      const data = await res.json()
      if (!data.uuid) throw new Error("No UUID")
      setDepositUuid(data.uuid)
      openSignRequest(data.uuid, data.qr, data.deeplink)
    } catch {
      showToast("error", "Error creating loan request")
    } finally {
      setLoading(false)
    }
  }

  async function repayLoan(loan: Loan) {
    if (!wallet) return showToast("error", "Connect your wallet first")
    setLoading(true)
    try {
      const res = await fetch("/api/xaman/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          amount: loan.totalDue,
          asset: "RLUSD",
          lockMonths: 0,
          isRepayment: true,
          loanId: loan.id,
        }),
      })
      const data = await res.json()
      if (!data.uuid) throw new Error("No UUID")
      setDepositUuid(data.uuid)
      openSignRequest(data.uuid, data.qr, data.deeplink)
    } catch {
      showToast("error", "Error creating payment")
    } finally {
      setLoading(false)
    }
  }

  async function submitWithdrawal(
    asset: "XRP" | "RLUSD",
    withdrawAmt: number,
    positionId: string,
    maxAllowed: number
  ) {
    if (!wallet) return showToast("error", "Connect your wallet first")
    if (withdrawAmt <= 0) return showToast("error", "Enter a valid amount")
    if (withdrawAmt > maxAllowed + 1e-9)
      return showToast("error", "Cannot withdraw more than deposited + interest")

    setLoading(true)
    try {
      // Retiro sin firma del usuario — el admin paga desde el vault en 24-48h
      const res = await fetch("/api/xaman/withdraw/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          asset,
          amount: withdrawAmt,
          network: "xrp",
          destinationAddress: wallet, // retirar a la misma wallet del usuario
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Error")

      // Registrar localmente para mostrar en el historial
      const requestId = data.id ?? crypto.randomUUID()
      const ts = new Date().toLocaleString()
      const newRequest: WithdrawalRequest = {
        id: requestId, positionId, asset, amount: withdrawAmt,
        maxAmount: maxAllowed, status: "pending", ts, wallet,
      }
      saveWithdrawalRequests([newRequest, ...withdrawalRequests])
      const newTx: TxRecord = {
        id: requestId, type: "withdrawal", asset, amount: withdrawAmt,
        txid: "", ts, status: "pending", positionId,
      }
      save(positions, [newTx, ...txHistory])
      showToast("success", "Request sent — you'll receive your withdrawal in 24-48h")
    } catch (e: any) {
      showToast("error", e?.message ?? "Error requesting withdrawal")
    } finally {
      setLoading(false)
    }
  }

  async function withdraw(position: Position) {
    if (!hasRealFunds(position)) return showToast("error", "No funds in this position")
    if (!canWithdraw(position))
      return showToast("error", `Locked — ${daysLeft(position.endDate)} days`)
    if (hasPendingWithdrawal(position.id, withdrawalRequests))
      return showToast("error", "There is already a pending withdrawal for this position")
    if (hasPendingWithdrawalForAsset(position.asset, withdrawalRequests))
      return showToast("error", "There is already a pending withdrawal for this asset")
    const total = maxWithdrawable(position)
    if (total <= 0) return showToast("error", "No funds available")
    await submitWithdrawal(position.asset, total, position.id, total)
  }

  async function requestWithdrawal() {
    if (!wallet) return showToast("error", "Connect your wallet first")
    const amt = Number(withdrawAmount)
    if (!withdrawAmount || amt <= 0) return showToast("error", "Enter a valid amount")
    if (hasPendingWithdrawalForAsset(withdrawAsset, withdrawalRequests))
      return showToast("error", "There is already a pending withdrawal for this asset")

    const available = getAvailableBalance(withdrawAsset, activePositions)
    const locked = getLockedPositionsForAsset(withdrawAsset, activePositions)

    if (amt > available + 1e-9) {
      if (available === 0 && locked.length > 0) {
        const minDays = Math.min(...locked.map((p) => daysLeft(p.endDate)))
        return showToast("error", `Position locked — ${minDays} days remaining`)
      }
      return showToast("error", "Amount exceeds available balance")
    }

    const sourcePosition = activePositions.find(
      (p) => p.asset === withdrawAsset && hasRealFunds(p) && canWithdraw(p)
    )
    if (!sourcePosition)
      return showToast("error", "No unlocked positions for this asset")

    await submitWithdrawal(withdrawAsset, amt, sourcePosition.id, available)
    setWithdrawAmount("")
  }

  // ── Polling de estados de payload ─────────────────────────────────────────
  useEffect(() => {
    if (!connectUuid) return
    const iv = setInterval(async () => {
      try {
        const res = await fetch("/api/xaman/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uuid: connectUuid }),
        })
        const data = await res.json()
        if (data.signed && data.account) {
          storeSet("xaman_wallet", data.account).catch(() => {})
          setWallet(data.account)
          closeModal()
          showToast("success", "Wallet connected ✓")
          clearInterval(iv)
        } else if (data.cancelled || data.expired) {
          closeModal()
          showToast("error", "Connection cancelled")
          clearInterval(iv)
        }
      } catch {}
    }, 2000)
    return () => clearInterval(iv)
  }, [connectUuid])

  useEffect(() => {
    if (!depositUuid) return
    const iv = setInterval(async () => {
      try {
        const res = await fetch("/api/xaman/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uuid: depositUuid }),
        })
        const data = await res.json()
        if (data.signed && data.txid) {
          const now = new Date().toISOString()
          const newPosition: Position = {
            id: crypto.randomUUID(),
            asset,
            amount: Number(amount),
            lockMonths,
            apy: getDisplayedApy(asset, lockMonths),
            startDate: now,
            endDate: calcEndDate(now, lockMonths),
            status: "active",
            txid: data.txid,
          }
          const newTx: TxRecord = {
            id: crypto.randomUUID(),
            type: "deposit",
            asset,
            amount: Number(amount),
            txid: data.txid,
            ts: new Date().toLocaleString(),
            status: "confirmed",
          }
          save([newPosition, ...positions], [newTx, ...txHistory])
          await fetch("/api/xaman/positions/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wallet,
              asset,
              amount,
              lockMonths,
              apy: getDisplayedApy(asset, lockMonths),
              txid: data.txid,
              endDate: calcEndDate(new Date().toISOString(), lockMonths),
            }),
          }).catch(() => {})
          setAmount("")
          setDepositUuid(null)
          closeModal()
          showToast("success", `Deposit confirmed ✓ — ${amount} ${asset}`)
          setTab("positions")
          clearInterval(iv)
        } else if (data.cancelled || data.expired) {
          closeModal()
          showToast("error", "Deposit cancelled")
          clearInterval(iv)
        }
      } catch {}
    }, 2000)
    return () => clearInterval(iv)
  }, [depositUuid])

  // withdrawUuid polling eliminado — retiros ya no requieren firma del usuario

  // ── Derived state ─────────────────────────────────────────────────────────
  const activePositions = positions.filter((p) => p.status === "active")
  const deposits = txHistory.filter((tx) => tx.type === "deposit")
  const withdrawals = txHistory.filter((tx) => tx.type === "withdrawal")
  const availableAssets = useMemo(() => getAvailableAssets(activePositions), [activePositions])
  const withdrawAvailableBalance = useMemo(
    () => getAvailableBalance(withdrawAsset, activePositions),
    [withdrawAsset, activePositions]
  )
  const withdrawPendingForAsset = hasPendingWithdrawalForAsset(withdrawAsset, withdrawalRequests)

  useEffect(() => {
    const assets = getAvailableAssets(activePositions)
    if (assets.length > 0 && !assets.includes(withdrawAsset)) setWithdrawAsset(assets[0])
  }, [activePositions, withdrawAsset])

  const totalDeposited = useMemo(
    () => activePositions.reduce((acc, p) => acc + Number(p.amount), 0),
    [activePositions]
  )
  const totalInterest = useMemo(
    () => activePositions.reduce(
      (acc, p) => acc + (frozenBalances[p.id]?.interest ?? calcInterest(Number(p.amount), REAL_APY[p.asset], p.startDate)),
      0
    ),
    [activePositions, frozenBalances]
  )
  const totalLoaned = useMemo(
    () =>
      loans
        .filter((l) => l.status === "active")
        .reduce((acc, l) => acc + Number(l.loanAmount), 0),
    [loans]
  )
  // RLUSD depositado en la plataforma (disponible como colateral)
  const rlusdVaultBalance = useMemo(
    () =>
      activePositions
        .filter((p) => p.asset === "RLUSD" && hasRealFunds(p))
        .reduce((acc, p) => acc + maxWithdrawable(p), 0),
    [activePositions]
  )

  const estReturn =
    amount && Number(amount) > 0
      ? (Number(amount) * (REAL_APY[asset] / 100) * (lockMonths === 0 ? 1 : lockMonths / 12)).toFixed(4)
      : "0.00"

  // ── Loading inicial ───────────────────────────────────────────────────────
  if (!xummReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="text-center space-y-3">
          <div className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-400">{"Starting AX Vault…"}</p>
        </div>
      </div>
    )
  }

  // ── Splash screen (sin wallet) ────────────────────────────────────────────
  if (!wallet) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 py-12">
        {toast && (
          <div
            className={`fixed top-5 left-1/2 -translate-x-1/2 z-[200] px-4 py-3 rounded-xl text-sm font-medium shadow-xl border w-[calc(100%-2rem)] max-w-xs text-center
              ${toast.type === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`}
          >
            {toast.msg}
          </div>
        )}

        <h1 className="text-2xl font-bold text-gray-900 mb-1">AX Vault</h1>
        <p className="text-base text-gray-500 mb-8">{"XRPL Earn & Loans"}</p>

        <div className="w-full max-w-xs space-y-3 mb-8">
          {[
            { icon: "💰", text: "XRP up to 4.5% · RLUSD up to 7% APY" },
            { icon: "📈", text: "Flexible or locked positions" },
            { icon: "💳", text: "Loans with RLUSD collateral · 75% LTV" },
          ].map(({ icon, text }) => (
            <div
              key={text}
              className="flex items-center gap-3 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3"
            >
              <span className="text-xl shrink-0">{icon}</span>
              <span className="text-sm text-gray-700">{text}</span>
            </div>
          ))}
        </div>

        {isXapp ? (
          <div className="text-center space-y-3">
            <div className="w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-gray-400">{"Connecting with Xaman…"}</p>
          </div>
        ) : (
          <button
            onClick={connectWallet}
            disabled={loading}
            className="w-full max-w-xs min-h-[52px] rounded-2xl font-bold text-base text-white bg-gradient-to-r from-blue-500 to-violet-600 active:opacity-80 disabled:opacity-40"
          >
            {loading ? "Connecting…" : "Connect with Xaman"}
          </button>
        )}
      </div>
    )
  }

  // ── App principal ─────────────────────────────────────────────────────────
  return (
    <div className="xapp-root min-h-screen bg-white text-gray-900 font-sans pb-8">
      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-4 py-3 rounded-xl text-sm font-medium shadow-xl border w-[calc(100%-2rem)] max-w-xs text-center
            ${toast.type === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-base bg-clip-text text-transparent bg-gradient-to-r from-purple-600 to-violet-500">
            AX Vault
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-gray-700 font-mono text-xs">
              {wallet.slice(0, 6)}…{wallet.slice(-4)}
            </span>
          </div>
          <button
            onClick={disconnect}
            className="min-h-[36px] px-3 py-1.5 text-sm rounded-lg border border-red-200 text-red-600 active:bg-red-50"
          >
            {"Exit"}
          </button>
        </div>
      </header>

      {/* Stats */}
      <div className="px-4 pt-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Active positions", value: String(activePositions.length) },
            { label: "Total deposited", value: totalDeposited.toFixed(2) },
            { label: "Interest earned", value: `+${totalInterest.toFixed(4)}` },
            { label: "Active loans", value: totalLoaned.toFixed(2) },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl bg-gray-50 border border-gray-200 p-3 text-center"
            >
              <p className="text-xs text-gray-500 mb-1">{s.label}</p>
              <p className="text-base font-semibold text-gray-900">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar — horizontalmente scrollable para 390px */}
      <div className="px-4 pt-4">
        <div className="flex gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-1 shadow-sm [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              { key: "deposit", label: "💰 Deposit" },
              {
                key: "positions",
                label: `${"📊 Positions"}${activePositions.length > 0 ? ` (${activePositions.length})` : ""}`,
              },
              { key: "withdraw", label: "⬆️ Withdraw" },
              { key: "loans", label: "💳 Loans" },
              { key: "history", label: "📋 History" },
            ] as { key: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 px-3 py-2.5 rounded-lg text-sm font-medium min-h-[40px] active:opacity-80 transition-colors
                ${tab === t.key ? "bg-gradient-to-r from-blue-500 to-violet-600 text-white" : "text-gray-500"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="px-4 pt-4 space-y-4">

        {/* ── DEPOSIT TAB ── */}
        {tab === "deposit" && (
          <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-5">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{"Asset"}</p>
              <div className="flex gap-3">
                {(["XRP", "RLUSD"] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAsset(a)}
                    className={`flex-1 min-h-[48px] rounded-xl text-sm font-semibold border active:opacity-80 transition-colors
                      ${asset === a
                        ? "bg-gradient-to-r from-blue-500/20 to-violet-600/20 border-blue-500/50 text-gray-900"
                        : "border-gray-200 text-gray-500"}`}
                  >
                    <span className="flex flex-col items-center justify-center gap-0.5">
                      <span className="flex items-center gap-1.5">
                        {a === "XRP" ? (
                          <img
                            src="https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png"
                            alt="XRP"
                            className="w-5 h-5 object-contain"
                          />
                        ) : (
                          <img
                            src="/icons/rlusd.svg"
                            alt="RLUSD"
                            className="w-5 h-5 object-contain"
                          />
                        )}
                        <span>{a}</span>
                      </span>
                      <span className="text-[10px] font-normal opacity-60">{ASSET_APY_RANGE[a]}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                {"Period"} · <span className="text-violet-600 font-semibold normal-case">{getApyLabel(asset, lockMonths)} APY</span>
              </p>
              <div className="grid grid-cols-5 gap-1.5">
                {LOCK_OPTIONS.map((opt) => (
                  <button
                    key={opt.months}
                    onClick={() => setLockMonths(opt.months)}
                    className={`min-h-[44px] rounded-xl text-xs font-semibold border active:opacity-80 text-center
                      ${lockMonths === opt.months
                        ? "bg-gradient-to-r from-blue-500/20 to-violet-600/20 border-blue-500/50 text-gray-900"
                        : "border-gray-200 text-gray-500"}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">{"Interest updated every 7 days"}</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">{"Amount"}</p>
                <span className="text-xs text-gray-400">
                  {"Available:"}{" "}
                  <span className="font-semibold text-gray-700">
                    {walletBalance[asset].toFixed(4)} {asset}
                  </span>
                </span>
              </div>
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3.5 pr-24 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500/50 text-lg font-medium"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAmount(walletBalance[asset].toFixed(6))}
                    disabled={walletBalance[asset] <= 0}
                    className="px-2 py-1 text-xs font-semibold rounded-lg border border-blue-200 text-blue-600 active:bg-blue-50 disabled:opacity-40"
                  >
                    MAX
                  </button>
                  <span className="text-gray-500 text-sm pr-1">{asset}</span>
                </div>
              </div>
              {!balanceLoading && walletBalance[asset] > 0 && Number(amount) > walletBalance[asset] + 1e-9 && (
                <p className="text-xs text-red-500 mt-1">
                  {`Exceeds available balance (${walletBalance[asset].toFixed(4)} ${asset})`}
                </p>
              )}
              <div className="flex gap-2 mt-2">
                {["10", "50", "100", "500"].map((q) => (
                  <button
                    key={q}
                    onClick={() => setAmount(q)}
                    className="flex-1 min-h-[36px] text-sm rounded-lg border border-gray-200 text-gray-500 active:bg-gray-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {Number(amount) > 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex justify-between items-center">
                <span className="text-sm text-gray-500">{"Estimated return"}</span>
                <span className="text-sm font-semibold text-emerald-600">
                  +{estReturn} {asset}
                </span>
              </div>
            )}

            <button
              onClick={deposit}
              disabled={loading || (!balanceLoading && walletBalance[asset] > 0 && Number(amount) > walletBalance[asset] + 1e-9)}
              className="w-full min-h-[52px] rounded-xl font-semibold text-base bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80 disabled:opacity-40"
            >
              {loading ? "Processing…" : `Deposit ${amount || "0"} ${asset}`}
            </button>
          </div>
        )}

        {/* ── POSITIONS TAB ── */}
        {tab === "positions" && (
          <div className="space-y-3">
            {activePositions.length === 0 ? (
              <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-10 text-center text-gray-500 text-sm">
                {"No active positions"}
              </div>
            ) : (
              activePositions.map((pos) => {
                const frozenInterest = getFrozenInterest(pos)
                const daysToUpdate = getDaysUntilUpdate(pos.id)
                const total = maxWithdrawable(pos)
                const unlocked = canWithdraw(pos)
                const days = daysLeft(pos.endDate)
                const realFunds = hasRealFunds(pos)
                const pending = hasPendingWithdrawal(pos.id, withdrawalRequests)
                const canWithdrawNow = canWithdrawPosition(pos, withdrawalRequests)
                return (
                  <div
                    key={pos.id}
                    className="rounded-2xl bg-white border border-gray-200 shadow-sm p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base font-semibold text-gray-900">
                          {pos.amount} {pos.asset}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                          {pos.lockMonths === 0 ? "Flexible" : `${pos.lockMonths}M lock`}
                        </span>
                      </div>
                      <span className="text-xs text-emerald-600 font-semibold">
                        {getApyLabel(pos.asset, pos.lockMonths)}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-xs text-gray-500">{"Interest"}</p>
                        <p className="text-sm text-emerald-600 font-medium">
                          +{frozenInterest.toFixed(6)}
                        </p>
                        {daysToUpdate > 0 && (
                          <p className="text-[10px] text-gray-400 mt-0.5">{"Updates in"} {daysToUpdate}d</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">{"Start"}</p>
                        <p className="text-sm text-gray-700">
                          {new Date(pos.startDate).toLocaleDateString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">
                          {pos.lockMonths === 0 ? "Status" : "Unlock date"}
                        </p>
                        <p className={`text-sm ${unlocked ? "text-emerald-600" : "text-amber-600"}`}>
                          {pos.lockMonths === 0
                            ? "Flexible"
                            : unlocked
                            ? "Unlocked ✓"
                            : `${days} ${"days"}`}
                        </p>
                      </div>
                    </div>
                    {pos.txid && (
                      <button
                        onClick={() =>
                          openBrowser(`https://livenet.xrpl.org/transactions/${pos.txid}`)
                        }
                        className="text-xs text-blue-600 font-mono text-left active:opacity-70"
                      >
                        TX: {pos.txid.slice(0, 12)}… ↗
                      </button>
                    )}
                    {pending && (
                      <p className="text-xs text-amber-600">{"Withdrawal pending — 24-48h"}</p>
                    )}
                    {realFunds && (
                      <button
                        onClick={() => withdraw(pos)}
                        disabled={!canWithdrawNow || loading}
                        className={`w-full min-h-[48px] rounded-xl text-sm font-semibold active:opacity-80
                          ${canWithdrawNow
                            ? "bg-gradient-to-r from-blue-500 to-violet-600 text-white"
                            : "border border-gray-200 text-gray-400"}`}
                      >
                        {!unlocked
                          ? `Locked — ${days} days`
                          : pending
                          ? "Withdrawal pending"
                          : `Withdraw ${total.toFixed(4)} ${pos.asset}`}
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* ── WITHDRAW TAB ── */}
        {tab === "withdraw" && (
          <div className="space-y-4">
            {availableAssets.length === 0 ? (
              <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-10 text-center text-gray-500 text-sm">
                {"No positions with funds to withdraw"}
              </div>
            ) : (
              <>
                <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-5">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{"Asset"}</p>
                    <div className="flex gap-3">
                      {availableAssets.map((a) => (
                        <button
                          key={a}
                          onClick={() => {
                            setWithdrawAsset(a)
                            setWithdrawAmount("")
                          }}
                          className={`flex-1 min-h-[48px] rounded-xl text-sm font-semibold border active:opacity-80
                            ${withdrawAsset === a
                              ? "bg-gradient-to-r from-blue-500/20 to-violet-600/20 border-blue-500/50 text-gray-900"
                              : "border-gray-200 text-gray-500"}`}
                        >
                          <span className="flex items-center justify-center gap-2">
                            {a === "XRP" ? (
                              <img
                                src="https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png"
                                alt="XRP"
                                className="w-5 h-5 object-contain"
                              />
                            ) : (
                              <img
                                src="/icons/rlusd.svg"
                                alt="RLUSD"
                                className="w-5 h-5 object-contain"
                              />
                            )}
                            {a}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex justify-between items-center">
                    <span className="text-sm text-gray-500">{"Available:"}</span>
                    <span className="text-sm font-semibold text-emerald-600">
                      {withdrawAvailableBalance.toFixed(4)} {withdrawAsset}
                    </span>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{"Amount"}</p>
                    <div className="relative">
                      <input
                        type="number"
                        value={withdrawAmount}
                        onChange={(e) => setWithdrawAmount(e.target.value)}
                        placeholder="0.00"
                        inputMode="decimal"
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3.5 pr-28 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500/50 text-lg font-medium"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setWithdrawAmount(withdrawAvailableBalance.toFixed(6))}
                          disabled={withdrawAvailableBalance <= 0}
                          className="px-2 py-1 text-xs font-semibold rounded-lg border border-blue-200 text-blue-600 active:bg-blue-50 disabled:opacity-40"
                        >
                          MAX
                        </button>
                        <span className="text-gray-500 text-sm pr-1">{withdrawAsset}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={requestWithdrawal}
                    disabled={
                      loading ||
                      withdrawPendingForAsset ||
                      withdrawAvailableBalance <= 0 ||
                      !withdrawAmount ||
                      Number(withdrawAmount) <= 0
                    }
                    className="w-full min-h-[52px] rounded-xl font-semibold text-base bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80 disabled:opacity-40"
                  >
                    {withdrawPendingForAsset
                      ? "Withdrawal pending for this asset"
                      : loading
                      ? "Processing…"
                      : "Request withdrawal"}
                  </button>
                </div>

                {withdrawalRequests.filter((r) => r.status !== "cancelled").length > 0 && (
                  <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-900">{"Withdrawal requests"}</h3>
                    {withdrawalRequests.filter((r) => r.status !== "cancelled").map((req) => (
                      <div
                        key={req.id}
                        className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0 gap-3"
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {req.amount.toFixed(4)} {req.asset}
                          </p>
                          <p className="text-xs text-gray-400">{req.ts}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full border ${
                              req.status === "confirmed"
                                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
                                : "bg-amber-500/10 border-amber-500/30 text-amber-600"
                            }`}
                          >
                            {req.status === "confirmed" ? "Completed ✓" : "Pending ⏳"}
                          </span>
                          {req.status === "pending" && (
                            <button
                              onClick={() => cancelWithdrawal(req.id)}
                              className="text-xs text-red-500 underline active:opacity-70 min-h-[32px] px-1"
                            >
                              {"Cancel"}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── LOANS TAB ── */}
        {tab === "loans" && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-5">
              <div>
                <h3 className="text-base font-semibold text-gray-900">{"RLUSD Loan"}</h3>
                <p className="text-sm text-gray-500 mt-1">Deposit RLUSD as collateral and receive 75% as a loan. 8% annual interest calculated daily. Minimum 30 days before repayment.</p>
              </div>

              <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {"Calculator"}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-gray-400">{"You deposit (collateral)"}</p>
                    <p className="text-base font-bold text-gray-900">
                      {loanCollateral || "0"} RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{"You receive (75% LTV)"}</p>
                    <p className="text-base font-bold text-violet-600">
                      {loanCollateral ? (Number(loanCollateral) * 0.75).toFixed(2) : "0"} RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{"Daily interest"}</p>
                    <p className="text-sm font-semibold text-amber-600">
                      {loanCollateral
                        ? (((Number(loanCollateral) * 0.75) * 8) / 100 / 365).toFixed(6)
                        : "0"}{" "}
                      RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{"Annual interest (8%)"}</p>
                    <p className="text-sm font-semibold text-amber-600">
                      {loanCollateral
                        ? ((Number(loanCollateral) * 0.75) * 0.08).toFixed(4)
                        : "0"}{" "}
                      RLUSD
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">
                    Collateral amount (RLUSD)
                  </p>
                  <span className="text-xs text-gray-400">
                    {"Deposited in vault:"}{" "}
                    <span className="font-semibold text-gray-700">
                      {rlusdVaultBalance.toFixed(4)} RLUSD
                    </span>
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    value={loanCollateral}
                    onChange={(e) => setLoanCollateral(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3.5 pr-24 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-violet-400 text-lg font-medium"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setLoanCollateral(rlusdVaultBalance.toFixed(6))}
                      disabled={rlusdVaultBalance <= 0}
                      className="px-2 py-1 text-xs font-semibold rounded-lg border border-violet-200 text-violet-600 active:bg-violet-50 disabled:opacity-40"
                    >
                      MAX
                    </button>
                    <span className="text-gray-400 text-sm pr-1">RLUSD</span>
                  </div>
                </div>
                {Number(loanCollateral) > rlusdVaultBalance + 1e-9 && rlusdVaultBalance > 0 && (
                  <p className="text-xs text-red-500 mt-1">
                    {`Exceeds RLUSD deposited in vault (rlusdVaultBalance.toFixed(4))`}
                  </p>
                )}
                <div className="flex gap-2 mt-2">
                  {["1", "10", "100", "1000"].map((q) => (
                    <button
                      key={q}
                      onClick={() => setLoanCollateral(q)}
                      className="flex-1 min-h-[36px] text-sm rounded-lg border border-gray-200 text-gray-500 active:bg-gray-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-1.5">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">
                  {"Loan terms"}
                </p>
                <div className="space-y-1 text-sm text-amber-700">
                  <p>{"✓ LTV: 75% — deposit 100 RLUSD, receive 75 RLUSD"}</p>
                  <p>{"✓ Interest: 8% APY calculated daily"}</p>
                  <p>{"✓ Minimum period: 30 days before repayment"}</p>
                  <p>{"✓ Collateral held until full repayment"}</p>
                  <p>{"✓ Default: collateral retained if not repaid"}</p>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  id="loan-terms-xapp"
                  className="mt-0.5 w-4 h-4 accent-violet-600 shrink-0"
                />
                <span className="text-sm text-gray-600">
                  I accept the terms: 75% LTV · 8% APY · 30 day minimum · collateral retained in case of default.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      openBrowser(
                        `${process.env.NEXT_PUBLIC_BASE_URL ?? "https://asvexo.com"}/terms`
                      )
                    }
                    className="text-violet-600 underline"
                  >
                    {"View terms"}
                  </button>
                </span>
              </label>

              <button
                onClick={requestLoan}
                disabled={loading || !loanCollateral || Number(loanCollateral) <= 0}
                className="w-full min-h-[52px] rounded-xl font-semibold text-base bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80 disabled:opacity-40"
              >
                {`Request loan — deposit ${loanCollateral || "0"} RLUSD collateral`}
              </button>
            </div>

            {loans.filter((l) => l.status === "active").length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {"Active loans"}
                </p>
                {loans
                  .filter((l) => l.status === "active")
                  .map((loan) => (
                    <div
                      key={loan.id}
                      className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-base font-semibold text-gray-900">
                          {loan.loanAmount.toFixed(2)} RLUSD
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                          {loan.daysActive} days active
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-xs text-gray-400">{"Collateral"}</p>
                          <p className="text-sm font-semibold text-gray-900">
                            {loan.collateral} RLUSD
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">{"Interest"}</p>
                          <p className="text-sm font-semibold text-amber-600">
                            +{loan.interestAccrued.toFixed(6)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">{"Total due"}</p>
                          <p className="text-sm font-semibold text-gray-900">
                            {loan.totalDue.toFixed(4)}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => repayLoan(loan)}
                        disabled={!loan.canRepay}
                        className={`w-full min-h-[48px] rounded-xl text-sm font-semibold active:opacity-80
                          ${loan.canRepay
                            ? "bg-gradient-to-r from-blue-500 to-violet-600 text-white"
                            : "border border-gray-200 text-gray-400"}`}
                      >
                        {loan.canRepay
                          ? `Pay ${loan.totalDue.toFixed(4)} RLUSD → recover ${loan.collateral} RLUSD`
                          : `Available in ${30 - loan.daysActive} days`}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === "history" && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">{"Deposits"}</h3>
              {deposits.length === 0 ? (
                <p className="text-center text-gray-500 py-4 text-sm">{"No deposits yet"}</p>
              ) : (
                deposits.map((tx) => {
                  const txStatus = tx.status ?? (tx.txid ? "confirmed" : "pending")
                  return (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-lg">⬇️</span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {tx.amount.toFixed(4)} {tx.asset}
                          </p>
                          <p className="text-xs text-gray-400">{tx.ts}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            txStatus === "confirmed"
                              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                              : "bg-amber-50 border-amber-200 text-amber-700"
                          }`}
                        >
                          {txStatus === "confirmed" ? "Confirmed" : "Pending"}
                        </span>
                        {tx.txid && (
                          <button
                            onClick={() =>
                              openBrowser(`https://livenet.xrpl.org/transactions/${tx.txid}`)
                            }
                            className="text-xs text-blue-600 font-mono active:opacity-70"
                          >
                            {tx.txid.slice(0, 6)}… ↗
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">{"Withdrawals"}</h3>
              {withdrawals.length === 0 ? (
                <p className="text-center text-gray-500 py-4 text-sm">{"No withdrawals yet"}</p>
              ) : (
                withdrawals.map((tx) => {
                  const txStatus = tx.status ?? (tx.txid ? "confirmed" : "pending")
                  return (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-lg">⬆️</span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {tx.amount.toFixed(4)} {tx.asset}
                          </p>
                          <p className="text-xs text-gray-400">{tx.ts}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            txStatus === "confirmed"
                              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                              : "bg-amber-50 border-amber-200 text-amber-700"
                          }`}
                        >
                          {txStatus === "confirmed" ? "Completed" : "Pending"}
                        </span>
                        {tx.txid && (
                          <button
                            onClick={() =>
                              openBrowser(`https://livenet.xrpl.org/transactions/${tx.txid}`)
                            }
                            className="text-xs text-blue-600 font-mono active:opacity-70"
                          >
                            {tx.txid.slice(0, 6)}… ↗
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="px-4 pt-6 pb-8 text-center">
        <p className="text-xs text-gray-400 leading-relaxed">
          © 2026 AX Vault ·{" "}
          <button onClick={() => openBrowser("https://asvexo.com/terms")} className="underline active:opacity-70">{"Terms"}</button>
          {" · "}
          <button onClick={() => openBrowser("https://asvexo.com/privacy")} className="underline active:opacity-70">{"Privacy"}</button>
          {" · "}
          <button onClick={() => openBrowser("https://asvexo.com/contact")} className="underline active:opacity-70">{"Contact"}</button>
        </p>
      </footer>

      {/* ── QR Modal — anclado en la parte inferior en móvil ── */}
      {showModal && qr && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-center space-y-4 shadow-2xl">
            <h3 className="text-base font-semibold bg-clip-text text-transparent bg-gradient-to-r from-purple-600 to-violet-500">
              {connectUuid
                ? "Connect Xaman wallet"
                : withdrawUuid
                ? `Withdraw ${(withdrawModal?.amount ?? 0).toFixed(4)} ${withdrawModal?.asset ?? ""}`
                : `Deposit ${amount || "0"} ${asset}`}
            </h3>
            {countdown !== null && (
              <p className="text-xs text-gray-500">
                {"Expires in"}{" "}
                <span
                  className={`font-mono font-semibold ${
                    countdown < 60 ? "text-red-600" : "text-gray-700"
                  }`}
                >
                  {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                </span>
              </p>
            )}
            <img src={qr} alt="Xaman QR" className="mx-auto w-48 h-48 rounded-xl" />
            <p className="text-sm text-gray-500">
              {"Scan with your Xaman app"}
            </p>
            {deeplink && (
              <a
                href={deeplink}
                className="flex items-center justify-center w-full min-h-[52px] rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80"
              >
                {"Open in Xaman"}
              </a>
            )}
            <button
              onClick={closeModal}
              className="w-full min-h-[44px] text-sm text-gray-500 active:text-gray-900"
            >
              {"Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
