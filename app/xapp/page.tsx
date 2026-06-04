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
const APY = 3

const LOCK_OPTIONS = [
  { months: 0, label: "Flexible" },
  { months: 1, label: "1 mes" },
  { months: 3, label: "3 meses" },
  { months: 6, label: "6 meses" },
  { months: 12, label: "12 meses" },
]

function calcInterest(amount: number, apy: number, startDate: string): number {
  const days = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
  return amount * (apy / 100) * (days / 365)
}

function calcLoanInterest(amount: number, rate: number, startDate: string): number {
  const days = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
  return amount * (rate / 100) * (days / 365)
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
  return position.amount + calcInterest(position.amount, position.apy, position.startDate)
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
            localStorage.setItem("xaman_wallet", account)
            setWallet(account)
            setXummReady(true)
            return
          }
          // Último recurso: listener "retrieved"
          xumm.user.on("retrieved", async () => {
            const acc = await xumm.user.account
            if (acc) {
              localStorage.setItem("xaman_wallet", acc)
              setWallet(acc)
            }
            setXummReady(true)
          })
        } else {
          // Browser normal: recuperar sesión guardada
          const saved = localStorage.getItem("xaman_wallet")
          if (saved) setWallet(saved)
          setXummReady(true)
        }
      } catch {
        const saved = localStorage.getItem("xaman_wallet")
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

  // ── Cargar estado persistido de localStorage ─────────────────────────────
  useEffect(() => {
    const p = localStorage.getItem("xaman_positions")
    if (p) try { setPositions(JSON.parse(p)) } catch {}
    const h = localStorage.getItem("xaman_history")
    if (h) try { setTxHistory(JSON.parse(h)) } catch {}
    const wr = localStorage.getItem("xaman_withdrawal_requests")
    if (wr) try { setWithdrawalRequests(JSON.parse(wr)) } catch {}
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

  // ── Cargar datos de DB cuando wallet está lista ──────────────────────────
  useEffect(() => {
    if (!wallet) return

    async function loadFromDB() {
      try {
        const res = await fetch(`/api/xaman/positions?wallet=${wallet}`)
        const data = await res.json()
        if (data.deposits && data.deposits.length > 0) {
          setPositions(
            data.deposits.map((d: any) => ({
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
        }
        if (data.withdrawals && data.withdrawals.length > 0) {
          setTxHistory(
            data.withdrawals.map((w: any) => ({
              id: w.id,
              type: "withdrawal",
              asset: w.asset,
              amount: Number(w.total),
              txid: w.txid ?? "",
              ts: new Date(w.requestedAt).toLocaleString(),
              status: w.txid ? "confirmed" : "pending",
            }))
          )
        }
        if (data.loans && data.loans.length > 0) {
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
  }, [wallet])

  // ── Helpers ───────────────────────────────────────────────────────────────
  function save(newPositions: Position[], newHistory: TxRecord[]) {
    setPositions(newPositions)
    setTxHistory(newHistory)
    localStorage.setItem("xaman_positions", JSON.stringify(newPositions))
    localStorage.setItem("xaman_history", JSON.stringify(newHistory))
  }

  function saveWithdrawalRequests(requests: WithdrawalRequest[]) {
    setWithdrawalRequests(requests)
    localStorage.setItem("xaman_withdrawal_requests", JSON.stringify(requests))
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
          showToast("error", "QR expirado — intenta de nuevo")
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
    showToast("success", "Retiro cancelado")
    // Sincronizar con DB (no bloqueante)
    fetch("/api/xaman/withdraw/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, wallet }),
    }).catch(() => {})
  }

  function disconnect() {
    localStorage.removeItem("xaman_wallet")
    setWallet(null)
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
          localStorage.setItem("xaman_wallet", account)
          setWallet(account)
          showToast("success", "Wallet conectada ✓")
        } else {
          showToast("error", "No se pudo obtener la cuenta")
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
      showToast("error", e?.message ?? "Error al conectar")
    } finally {
      setLoading(false)
    }
  }

  async function deposit() {
    if (!wallet) return showToast("error", "Conecta tu wallet primero")
    const amt = Number(amount)
    if (!amount || amt <= 0) return showToast("error", "Ingresa un monto válido")
    if (!balanceLoading && walletBalance[asset] > 0 && amt > walletBalance[asset] + 1e-9)
      return showToast("error", `Saldo insuficiente — disponible: ${walletBalance[asset].toFixed(4)} ${asset}`)
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
      showToast("error", "Error al crear depósito")
    } finally {
      setLoading(false)
    }
  }

  async function requestLoan() {
    if (!wallet) return showToast("error", "Conecta tu wallet primero")
    if (!loanCollateral || Number(loanCollateral) <= 0)
      return showToast("error", "Ingresa el monto de colateral")
    const termsCheckbox = document.getElementById("loan-terms-xapp") as HTMLInputElement
    if (!termsCheckbox?.checked) return showToast("error", "Acepta los términos del préstamo")
    if (Number(loanCollateral) > rlusdVaultBalance + 1e-9)
      return showToast("error", `Colateral supera tu RLUSD en vault (${rlusdVaultBalance.toFixed(4)})`)

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
      showToast("error", "Error al crear solicitud de préstamo")
    } finally {
      setLoading(false)
    }
  }

  async function repayLoan(loan: Loan) {
    if (!wallet) return showToast("error", "Conecta tu wallet primero")
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
      showToast("error", "Error al crear pago")
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
    if (!wallet) return showToast("error", "Conecta tu wallet primero")
    if (withdrawAmt <= 0) return showToast("error", "Ingresa un monto válido")
    if (withdrawAmt > maxAllowed + 1e-9)
      return showToast("error", "No puedes retirar más del depositado + interés")

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
      showToast("success", "Solicitud enviada — recibirás tu retiro en 24-48h")
    } catch (e: any) {
      showToast("error", e?.message ?? "Error al solicitar retiro")
    } finally {
      setLoading(false)
    }
  }

  async function withdraw(position: Position) {
    if (!hasRealFunds(position)) return showToast("error", "Sin fondos en esta posición")
    if (!canWithdraw(position))
      return showToast("error", `Bloqueado — ${daysLeft(position.endDate)} días restantes`)
    if (hasPendingWithdrawal(position.id, withdrawalRequests))
      return showToast("error", "Ya hay un retiro pendiente para esta posición")
    if (hasPendingWithdrawalForAsset(position.asset, withdrawalRequests))
      return showToast("error", "Ya hay un retiro pendiente para este activo")
    const total = maxWithdrawable(position)
    if (total <= 0) return showToast("error", "Sin fondos disponibles")
    await submitWithdrawal(position.asset, total, position.id, total)
  }

  async function requestWithdrawal() {
    if (!wallet) return showToast("error", "Conecta tu wallet primero")
    const amt = Number(withdrawAmount)
    if (!withdrawAmount || amt <= 0) return showToast("error", "Ingresa un monto válido")
    if (hasPendingWithdrawalForAsset(withdrawAsset, withdrawalRequests))
      return showToast("error", "Ya hay un retiro pendiente para este activo")

    const available = getAvailableBalance(withdrawAsset, activePositions)
    const locked = getLockedPositionsForAsset(withdrawAsset, activePositions)

    if (amt > available + 1e-9) {
      if (available === 0 && locked.length > 0) {
        const minDays = Math.min(...locked.map((p) => daysLeft(p.endDate)))
        return showToast("error", `Posición bloqueada — ${minDays} días restantes`)
      }
      return showToast("error", "Monto supera el saldo disponible")
    }

    const sourcePosition = activePositions.find(
      (p) => p.asset === withdrawAsset && hasRealFunds(p) && canWithdraw(p)
    )
    if (!sourcePosition)
      return showToast("error", "Sin posiciones desbloqueadas para este activo")

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
          localStorage.setItem("xaman_wallet", data.account)
          setWallet(data.account)
          closeModal()
          showToast("success", "Wallet conectada ✓")
          clearInterval(iv)
        } else if (data.cancelled || data.expired) {
          closeModal()
          showToast("error", "Conexión cancelada")
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
            apy: APY,
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
              apy: 3.0,
              txid: data.txid,
              endDate: calcEndDate(new Date().toISOString(), lockMonths),
            }),
          }).catch(() => {})
          setAmount("")
          closeModal()
          showToast("success", `Depósito confirmado ✓ — ${amount} ${asset}`)
          setTab("positions")
          clearInterval(iv)
        } else if (data.cancelled || data.expired) {
          closeModal()
          showToast("error", "Depósito cancelado")
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
    () =>
      activePositions.reduce(
        (acc, p) => acc + calcInterest(Number(p.amount), Number(p.apy), p.startDate),
        0
      ),
    [activePositions]
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
      ? (Number(amount) * (APY / 100) * (lockMonths === 0 ? 1 : lockMonths / 12)).toFixed(4)
      : "0.00"

  // ── Loading inicial ───────────────────────────────────────────────────────
  if (!xummReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="text-center space-y-3">
          <div className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-400">Iniciando AX Vault…</p>
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
        <p className="text-base text-gray-500 mb-8">XRPL Earn &amp; Loans</p>

        <div className="w-full max-w-xs space-y-3 mb-8">
          {[
            { icon: "💰", text: "Deposita XRP y RLUSD · 3% APY" },
            { icon: "📈", text: "Posiciones flexibles o con lock" },
            { icon: "💳", text: "Préstamos con colateral RLUSD · 75% LTV" },
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
            <p className="text-sm text-gray-400">Conectando con Xaman…</p>
          </div>
        ) : (
          <button
            onClick={connectWallet}
            disabled={loading}
            className="w-full max-w-xs min-h-[52px] rounded-2xl font-bold text-base text-white bg-gradient-to-r from-blue-500 to-violet-600 active:opacity-80 disabled:opacity-40"
          >
            {loading ? "Conectando…" : "Conectar con Xaman"}
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
            Salir
          </button>
        </div>
      </header>

      {/* Stats */}
      <div className="px-4 pt-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Posiciones activas", value: String(activePositions.length) },
            { label: "Total depositado", value: totalDeposited.toFixed(2) },
            { label: "Interés ganado", value: `+${totalInterest.toFixed(4)}` },
            { label: "Préstamos activos", value: totalLoaned.toFixed(2) },
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
              { key: "deposit", label: "💰 Depositar" },
              {
                key: "positions",
                label: `📊 Posiciones${activePositions.length > 0 ? ` (${activePositions.length})` : ""}`,
              },
              { key: "withdraw", label: "⬆️ Retirar" },
              { key: "loans", label: "💳 Préstamos" },
              { key: "history", label: "📋 Historial" },
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
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Activo</p>
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

            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                Período de lock · 3% APY
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
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Monto</p>
                <span className="text-xs text-gray-400">
                  Disponible:{" "}
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
                  Supera el saldo disponible ({walletBalance[asset].toFixed(4)} {asset})
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
                <span className="text-sm text-gray-500">Retorno estimado</span>
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
              {loading ? "Procesando…" : `Depositar ${amount || "0"} ${asset}`}
            </button>
          </div>
        )}

        {/* ── POSITIONS TAB ── */}
        {tab === "positions" && (
          <div className="space-y-3">
            {activePositions.length === 0 ? (
              <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-10 text-center text-gray-500 text-sm">
                Sin posiciones activas
              </div>
            ) : (
              activePositions.map((pos) => {
                const interest = calcInterest(pos.amount, pos.apy, pos.startDate)
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
                        {pos.apy}% APY
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-xs text-gray-500">Interés</p>
                        <p className="text-sm text-emerald-600 font-medium">
                          +{interest.toFixed(6)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Inicio</p>
                        <p className="text-sm text-gray-700">
                          {new Date(pos.startDate).toLocaleDateString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">
                          {pos.lockMonths === 0 ? "Estado" : "Desbloqueo"}
                        </p>
                        <p className={`text-sm ${unlocked ? "text-emerald-600" : "text-amber-600"}`}>
                          {pos.lockMonths === 0
                            ? "Flexible"
                            : unlocked
                            ? "Libre ✓"
                            : `${days} días`}
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
                      <p className="text-xs text-amber-600">Retiro pendiente — 24-48h</p>
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
                          ? `Bloqueado — ${days} días`
                          : pending
                          ? "Retiro pendiente"
                          : `Retirar ${total.toFixed(4)} ${pos.asset}`}
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
                Sin posiciones con fondos para retirar
              </div>
            ) : (
              <>
                <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-5">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Activo</p>
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
                    <span className="text-sm text-gray-500">Disponible</span>
                    <span className="text-sm font-semibold text-emerald-600">
                      {withdrawAvailableBalance.toFixed(4)} {withdrawAsset}
                    </span>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Monto</p>
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
                      ? "Retiro pendiente para este activo"
                      : loading
                      ? "Procesando…"
                      : "Solicitar retiro"}
                  </button>
                </div>

                {withdrawalRequests.filter((r) => r.status !== "cancelled").length > 0 && (
                  <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-5 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-900">Solicitudes de retiro</h3>
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
                            {req.status === "confirmed" ? "Completado ✓" : "Pendiente ⏳"}
                          </span>
                          {req.status === "pending" && (
                            <button
                              onClick={() => cancelWithdrawal(req.id)}
                              className="text-xs text-red-500 underline active:opacity-70 min-h-[32px] px-1"
                            >
                              Cancelar
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
                <h3 className="text-base font-semibold text-gray-900">Préstamo RLUSD</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Deposita RLUSD como colateral y recibe el 75% como préstamo. 8% interés anual
                  calculado diariamente. Mínimo 30 días antes de pagar.
                </p>
              </div>

              <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Calculadora
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-gray-400">Depositas (colateral)</p>
                    <p className="text-base font-bold text-gray-900">
                      {loanCollateral || "0"} RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Recibes (75% LTV)</p>
                    <p className="text-base font-bold text-violet-600">
                      {loanCollateral ? (Number(loanCollateral) * 0.75).toFixed(2) : "0"} RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Interés diario</p>
                    <p className="text-sm font-semibold text-amber-600">
                      {loanCollateral
                        ? (((Number(loanCollateral) * 0.75) * 8) / 100 / 365).toFixed(6)
                        : "0"}{" "}
                      RLUSD
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Interés anual (8%)</p>
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
                    Monto de colateral (RLUSD)
                  </p>
                  <span className="text-xs text-gray-400">
                    Depositado en vault:{" "}
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
                    Supera el RLUSD depositado en vault ({rlusdVaultBalance.toFixed(4)})
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
                  Términos del préstamo
                </p>
                <div className="space-y-1 text-sm text-amber-700">
                  <p>✓ LTV: 75% — deposita 100 RLUSD, recibe 75 RLUSD</p>
                  <p>✓ Interés: 8% APY calculado diariamente</p>
                  <p>✓ Período mínimo: 30 días antes del pago</p>
                  <p>✓ Colateral retenido hasta pago completo</p>
                  <p>✓ Default: colateral retenido si no se paga</p>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  id="loan-terms-xapp"
                  className="mt-0.5 w-4 h-4 accent-violet-600 shrink-0"
                />
                <span className="text-sm text-gray-600">
                  Acepto los términos: 75% LTV · 8% APY · 30 días mínimo · colateral retenido en
                  caso de default.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      openBrowser(
                        `${process.env.NEXT_PUBLIC_BASE_URL ?? "https://asvexo.com"}/terms`
                      )
                    }
                    className="text-violet-600 underline"
                  >
                    Ver términos
                  </button>
                </span>
              </label>

              <button
                onClick={requestLoan}
                disabled={loading || !loanCollateral || Number(loanCollateral) <= 0}
                className="w-full min-h-[52px] rounded-xl font-semibold text-base bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80 disabled:opacity-40"
              >
                {`Solicitar préstamo — depositar ${loanCollateral || "0"} RLUSD colateral`}
              </button>
            </div>

            {loans.filter((l) => l.status === "active").length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Préstamos activos
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
                          {loan.daysActive} días activo
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-xs text-gray-400">Colateral</p>
                          <p className="text-sm font-semibold text-gray-900">
                            {loan.collateral} RLUSD
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">Interés</p>
                          <p className="text-sm font-semibold text-amber-600">
                            +{loan.interestAccrued.toFixed(6)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">Total a pagar</p>
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
                          ? `Pagar ${loan.totalDue.toFixed(4)} RLUSD → recuperar ${loan.collateral} RLUSD`
                          : `Disponible en ${30 - loan.daysActive} días`}
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
              <h3 className="text-sm font-semibold text-gray-900">Depósitos</h3>
              {deposits.length === 0 ? (
                <p className="text-center text-gray-500 py-4 text-sm">Sin depósitos aún</p>
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
                          {txStatus === "confirmed" ? "Confirmado" : "Pendiente"}
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
              <h3 className="text-sm font-semibold text-gray-900">Retiros</h3>
              {withdrawals.length === 0 ? (
                <p className="text-center text-gray-500 py-4 text-sm">Sin retiros aún</p>
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
                          {txStatus === "confirmed" ? "Completado" : "Pendiente"}
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
          <button onClick={() => openBrowser("https://asvexo.com/terms")} className="underline active:opacity-70">Términos</button>
          {" · "}
          <button onClick={() => openBrowser("https://asvexo.com/privacy")} className="underline active:opacity-70">Privacidad</button>
          {" · "}
          <button onClick={() => openBrowser("https://asvexo.com/contact")} className="underline active:opacity-70">Contacto</button>
        </p>
      </footer>

      {/* ── QR Modal — anclado en la parte inferior en móvil ── */}
      {showModal && qr && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-center space-y-4 shadow-2xl">
            <h3 className="text-base font-semibold bg-clip-text text-transparent bg-gradient-to-r from-purple-600 to-violet-500">
              {connectUuid
                ? "Conectar wallet Xaman"
                : withdrawUuid
                ? `Retirar ${withdrawModal?.amount.toFixed(4)} ${withdrawModal?.asset}`
                : `Depositar ${asset}`}
            </h3>
            {countdown !== null && (
              <p className="text-xs text-gray-500">
                Expira en{" "}
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
              {withdrawUuid
                ? "Admin: escanea para firmar el pago"
                : "Escanea con tu app Xaman"}
            </p>
            {deeplink && (
              <a
                href={deeplink}
                className="flex items-center justify-center w-full min-h-[52px] rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-500 to-violet-600 text-white active:opacity-80"
              >
                Abrir en Xaman
              </a>
            )}
            <button
              onClick={closeModal}
              className="w-full min-h-[44px] text-sm text-gray-500 active:text-gray-900"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
