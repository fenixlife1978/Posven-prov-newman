"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Search, 
  ShoppingCart, 
  Trash2, 
  Plus, 
  Receipt, 
  Barcode, 
  Wallet, 
  X, 
  CheckCircle2, 
  FileText,
  History,
  ClipboardList,
  ArrowLeft,
  Eye,
  Clock,
  Printer,
  Zap,
  Share2,
  UserPlus,
  User,
  AlertTriangle,
  Undo2,
  Lock,
  RefreshCw,
  Check,
  RotateCcw,
  HandCoins,
  Calculator,
  TrendingUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Contact,
  Maximize2,
  Minimize2,
  Tag,
  Loader2,
  Hash
} from 'lucide-react';
import { auth } from '@/lib/firebase';
import { ReceiptModal } from '@/components/pos/ReceiptModal';
import FloatingPaymentModal from '@/components/pos/FloatingPaymentModal';
import { toast } from '@/hooks/use-toast';
import { AppState, SaleItem, Sale, PaymentMethod, ReportZ, PagoRealizado, Customer, Return, ReturnItem, Product, Debt, Movimiento, LibroDiarioEntry } from '@/lib/types';
import { Utils, Store } from '@/lib/db-store';
import ReturnsModule from '@/components/modules/ReturnsModule';
import { cn } from '@/lib/utils';

// ✅ ELIMINADO: El declare global ya está en ReceiptModal.tsx

export default function SalesModule({ state, updateState }: { state: AppState, updateState: (s: Partial<AppState>) => void }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'pos' | 'history' | 'credits' | 'returns'>('pos');
  const [showReportType, setShowReportType] = useState<'REPORT_X' | 'REPORT_Z' | null>(null);
  const [reportSnapshot, setReportSnapshot] = useState<any>(null);
  const [cliente, setCliente] = useState('Consumidor final');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const processingRef = useRef(false);
  
  const [pagos, setPagos] = useState<PagoRealizado[]>([]);
  const [showMultiModal, setShowMultiModal] = useState(false);
  
  const [showAbonoModal, setShowAbonoModal] = useState<Debt | null>(null);
  const [globalCreditCustomer, setGlobalCreditCustomer] = useState<{ name: string; cedula?: string; totalUSD: number; totalBS: number } | null>(null);
  
  const [showDetails, setShowDetails] = useState<any | null>(null);
  const [lastProcessedSale, setLastProcessedSale] = useState<any | null>(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [selectedProductDisplay, setSelectedProductDisplay] = useState<Product | null>(null);
  
  const [priceSelectorItem, setPriceSelectorItem] = useState<{ index: number, product: Product } | null>(null);

  const [isCreditView, setIsCreditView] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState<Customer | null>(null);
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClient, setNewClient] = useState({ name: '', tipoDoc: 'V', cedula: '', phone: '', address: '' });

  const [editandoTasa, setEditandoTasa] = useState(false);
  const [nuevaTasa, setNuevaTasa] = useState(state.tasa.toString());

  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [showClientHistory, setShowClientHistory] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const formatVNCedula = (val: string) => {
    const digits = val.replace(/\D/g, '');
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  };

  const handleNewClientCedulaChange = (val: string) => {
    setNewClient({ ...newClient, cedula: formatVNCedula(val) });
  };

  const currentTerminal = useMemo(() => {
    return auth?.currentUser ? state.terminales.find(t => t.usuarioId === auth.currentUser!.uid) : null;
  }, [state.terminales]);

  const getFreshReportData = (windowStart?: string, windowEndExclusive?: string) => {
    // ✅ FIX: Obtener datos frescos del Store para evitar inconsistencias
    const freshState = Store.get();
    const corteTimestamp = windowStart ?? (Utils.getTerminalCash(currentTerminal).fechaUltimoZ || freshState.fechaUltimoZ || '');
    const termId = currentTerminal?.id || 'GLOBAL';
    
    // Usar datos frescos del Store en lugar del state del componente
    const allVentas = freshState.ventas || [];
    const allDevoluciones = freshState.devoluciones || [];
    const allLibroDiario = freshState.libroDiario || [];
    
    const inWindow = (fecha: string) => fecha > corteTimestamp && (!windowEndExclusive || fecha < windowEndExclusive);
    const vActivas = allVentas.filter(v => inWindow(v.fecha) && v.estado !== 'anulada' && v.terminalId === termId);
    const vAnuladas = allVentas.filter(v => inWindow(v.fecha) && v.estado === 'anulada' && v.terminalId === termId);
    const dHoy = allDevoluciones.filter(d => inWindow(d.fecha) && (allVentas.find(v => v.id === d.ventaId)?.terminalId === termId));
    
    const brUSD = vActivas.reduce((s, v) => s + v.totalUSD, 0);
    const devUSD = dHoy.reduce((s, d) => s + d.totalUSD, 0);
    const descUSD = vActivas.reduce((s, v) => s + (v.descuentoUSD || 0), 0);
    const netUSD = brUSD - devUSD - descUSD;

    const baseImponibleUSD = vActivas.reduce((s, v) => s + (v.baseImponibleUSD || 0), 0);
    const ivaUSD = vActivas.reduce((s, v) => s + (v.ivaUSD || 0), 0);
    const exentoUSD = vActivas.reduce((s, v) => s + (v.exentoUSD || 0), 0);
    const igtfUSD = vActivas.reduce((s, v) => s + (v.igtfUSD || 0), 0);

    const paymentMethodsMap: Record<string, number> = {};
    vActivas.forEach(v => {
      if (v.payments && v.payments.length > 0) {
        v.payments.forEach(p => {
          paymentMethodsMap[p.metodo] = (paymentMethodsMap[p.metodo] || 0) + p.montoUSD;
        });
      } else if (v.metodoPago) {
        paymentMethodsMap[v.metodoPago] = (paymentMethodsMap[v.metodoPago] || 0) + v.totalUSD;
      }
    });

    const sortedVentas = vActivas.sort((a,b) => a.fecha.localeCompare(b.fecha));
    const desdeFactura = sortedVentas.length > 0 ? sortedVentas[0].id : 'N/A';
    const hastaFactura = sortedVentas.length > 0 ? sortedVentas[sortedVentas.length - 1].id : 'N/A';
    
    const sortedDevs = dHoy.sort((a,b) => a.fecha.localeCompare(b.fecha));
    const desdeNC = sortedDevs.length > 0 ? sortedDevs[0].id : 'N/A';
    const hastaNC = sortedDevs.length > 0 ? sortedDevs[sortedDevs.length - 1].id : 'N/A';

    const relevantDiario = allLibroDiario.filter(e => inWindow(e.fecha) && String(e.terminalId || '') === termId);

    const esAjusteDevolucionAnulacion = (e:any) => {
      const categoria = String(e?.categoria || '').trim().toUpperCase();
      return categoria === 'DEVOLUCION' || categoria === 'ANULACION' || categoria === 'ANULACIÓN';
    };

    // La moneda de un cobro de deuda se determina por el MÉTODO utilizado.
    // Nunca se usa montoUSD como equivalente para sumar el total USD de un cobro en BS.
    const esMetodoUSD = (metodo:any) => {
      const m = String(metodo || '').trim().toLowerCase();
      return ['efectivo_usd', 'efectivo usd', 'usd', 'dolar', 'dólar', 'zelle'].includes(m);
    };
    const esMetodoBS = (metodo:any) => {
      const m = String(metodo || '').trim().toLowerCase();
      return ['efectivo_bs', 'efectivo bs', 'efectivo', 'pagomovil', 'pago_movil', 'pago móvil', 'punto_venta', 'punto_de_venta', 'punto de venta', 'biopago', 'transferencia'].includes(m);
    };

    const cobroDeudaVentas = allVentas.filter(v =>
      inWindow(v.fecha) &&
      String(v.terminalId || '') === termId &&
      String(v.type || '').toUpperCase() === 'COBRO DEUDA'
    );

    // Preferimos los pagos guardados en el documento de cobro porque contienen
    // la moneda/origen real. El libro diario se usa como respaldo para cobros
    // históricos que no tengan payments.
    let cobrosDeudaUSD = 0;
    let cobrosDeudaBS = 0;
    cobroDeudaVentas.forEach((v:any) => {
      const pagos = Array.isArray(v.payments) && v.payments.length
        ? v.payments
        : [{ metodo: v.metodoPago || 'otros', montoUSD: v.totalUSD, montoBS: v.totalBS }];
      pagos.forEach((p:any) => {
        const metodo = String(p?.metodo || p?.method || 'otros');
        if (esMetodoUSD(metodo)) {
          cobrosDeudaUSD += Number(p?.montoUSD ?? p?.usdAmount ?? 0) || 0;
        } else if (esMetodoBS(metodo)) {
          cobrosDeudaBS += Number(p?.montoBS ?? p?.amountBS ?? p?.amount ?? 0) || 0;
        }
      });
    });

    // Cobros históricos sin documento COBRO DEUDA con payments: tomar cada moneda
    // desde el método del asiento y NO convertir BS -> USD.
    const cobrosDeudaConVenta = new Set(cobroDeudaVentas.map((v:any) => v.id));
    relevantDiario
      .filter((e:any) => e.tipo === 'ingreso' && String(e.categoria || '').toUpperCase() === 'COBRO_DEUDA')
      .forEach((e:any) => {
        const referencia = String(e.referencia || '');
        const yaContabilizado = referencia && cobroDeudaVentas.some((v:any) => referencia === v.id || referencia.includes(v.id));
        if (yaContabilizado) return;
        if (esMetodoUSD(e.metodo)) {
          cobrosDeudaUSD += Number(e.montoUSD) || 0;
        } else if (esMetodoBS(e.metodo)) {
          cobrosDeudaBS += Number(e.montoBS) || 0;
        }
      });

    const movimientosCaja = relevantDiario.filter((e:any) =>
      e.categoria !== 'VENTA' &&
      e.categoria !== 'COBRO_DEUDA' &&
      !esAjusteDevolucionAnulacion(e)
    );

    // Movimientos extraordinarios por moneda original.
    const movimientosBS = { entradas: 0, egresos: 0 };
    const movimientosUSD = { entradas: 0, egresos: 0 };
    movimientosCaja.forEach((e:any) => {
      const metodo = String(e?.metodo || 'otros');
      const esUSD = esMetodoUSD(metodo);
      const montoUSD = Number(e?.montoUSD) || 0;
      const montoBS = Number(e?.montoBS) || 0;
      if (e.tipo === 'ingreso') {
        if (esUSD) movimientosUSD.entradas += montoUSD;
        else if (esMetodoBS(metodo)) movimientosBS.entradas += montoBS;
      } else if (e.tipo === 'egreso') {
        if (esUSD) movimientosUSD.egresos += montoUSD;
        else if (esMetodoBS(metodo)) movimientosBS.egresos += montoBS;
      }
    });

    // Arqueo por método/moneda. Cobros de deuda se mantienen separados de ventas.
    const arqueoMap: Record<string, any> = {};
    const ensureArqueo = (metodo:string) => {
      if (!arqueoMap[metodo]) arqueoMap[metodo] = {
        ventasBS:0, ventasUSD:0, cobrosBS:0, cobrosUSD:0,
        devBS:0, devUSD:0, movPlusBS:0, movPlusUSD:0,
        movMinusBS:0, movMinusUSD:0
      };
      return arqueoMap[metodo];
    };
    const addPayment = (p:any) => {
      const metodo = String(p?.metodo || p?.method || 'otros');
      return {
        metodo,
        bs: Number(p?.montoBS ?? p?.amountBS ?? 0) || 0,
        usd: Number(p?.montoUSD ?? p?.amountUSD ?? 0) || 0
      };
    };

    vActivas.forEach((v:any) => {
      if (String(v.type || '').toUpperCase() === 'COBRO DEUDA') return;
      const pagos = Array.isArray(v.payments) && v.payments.length
        ? v.payments
        : [{ metodo:v.metodoPago || 'otros', montoUSD:v.totalUSD, montoBS:v.totalBS }];
      pagos.forEach((p:any) => {
        const x = addPayment(p);
        const row = ensureArqueo(x.metodo);
        if (esMetodoUSD(x.metodo)) row.ventasUSD += x.usd;
        else if (esMetodoBS(x.metodo)) row.ventasBS += x.bs;
      });
    });

    cobroDeudaVentas.forEach((v:any) => {
      const pagos = Array.isArray(v.payments) && v.payments.length
        ? v.payments
        : [{ metodo:v.metodoPago || 'otros', montoUSD:v.totalUSD, montoBS:v.totalBS }];
      pagos.forEach((p:any) => {
        const x = addPayment(p);
        const row = ensureArqueo(x.metodo);
        if (esMetodoUSD(x.metodo)) row.cobrosUSD += x.usd;
        else if (esMetodoBS(x.metodo)) row.cobrosBS += x.bs;
      });
    });

    const metodosArqueo = Object.entries(arqueoMap).map(([metodo,val]:any) => ({
      metodo,
      ...val,
      moneda: esMetodoUSD(metodo) ? 'USD' : 'BS'
    }));

    // EFECTIVO FÍSICO: únicamente efectivo BS y efectivo USD, en su moneda original.
    const efectivoBS = ensureArqueo('efectivo_bs');
    const efectivoUSD = ensureArqueo('efectivo_usd');
    const fondoBS = Number(freshState.fondoCajaHoyBS || 0);
    const fondoUSD = Number(freshState.fondoCajaHoyUSD || 0);

    const estimadoEfectivoBS = {
      fondo: fondoBS,
      ventas: Number(efectivoBS.ventasBS) || 0,
      cobrosDeuda: Number(efectivoBS.cobrosBS) || 0,
      entradas: Number(movimientosBS.entradas) || 0,
      devolucionesAnulaciones: Number(efectivoBS.devBS) || 0,
      egresos: Number(movimientosBS.egresos) || 0,
      total: fondoBS + (Number(efectivoBS.ventasBS)||0) + (Number(efectivoBS.cobrosBS)||0) +
        (Number(movimientosBS.entradas)||0) - (Number(efectivoBS.devBS)||0) - (Number(movimientosBS.egresos)||0)
    };
    const estimadoEfectivoUSD = {
      fondo: fondoUSD,
      ventas: Number(efectivoUSD.ventasUSD) || 0,
      cobrosDeuda: Number(efectivoUSD.cobrosUSD) || 0,
      entradas: Number(movimientosUSD.entradas) || 0,
      devolucionesAnulaciones: Number(efectivoUSD.devUSD) || 0,
      egresos: Number(movimientosUSD.egresos) || 0,
      total: fondoUSD + (Number(efectivoUSD.ventasUSD)||0) + (Number(efectivoUSD.cobrosUSD)||0) +
        (Number(movimientosUSD.entradas)||0) - (Number(efectivoUSD.devUSD)||0) - (Number(movimientosUSD.egresos)||0)
    };

    const ventasCreditoUSD = vActivas
      .filter((v:any) => String(v.metodoPago||'').toLowerCase() === 'credito' ||
        (Array.isArray(v.payments) && v.payments.some((p:any) => p.metodo === 'credito')))
      .reduce((s:number,v:any) => s + (Number(v.totalUSD)||0), 0);

    const totalSalidasCaja = movimientosBS.egresos + movimientosUSD.egresos;
    const totalEntradasCaja = movimientosBS.entradas + movimientosUSD.entradas;
    const terminalName = currentTerminal ? currentTerminal.nombre : 'SISTEMA GLOBAL';

    return { 
      brUSD, devUSD, descUSD, netUSD, igtfUSD, ivaUSD, baseImponibleUSD, exentoUSD,
      paymentMethods: paymentMethodsMap,
      manualSalidas: totalSalidasCaja,
      manualEntradas: totalEntradasCaja,
      cobrosDeudaUSD,
      cobrosDeudaBS,
      fondoAperturaUSD: freshState.fondoCajaHoyUSD || 0,
      fondoAperturaBS: freshState.fondoCajaHoyBS || 0,
      desdeFactura, hastaFactura, desdeNC, hastaNC,
      stats: { facturas: vActivas.length, devoluciones: dHoy.length, anulaciones: vAnuladas.length, ticketPromedio: vActivas.length > 0 ? (netUSD / vActivas.length) : 0 },
      fecha: Utils.ahora(), terminalName, terminalId: termId, numeroZ: freshState.ultimoZ + 1, acumuladoHistoricoUSD: freshState.acumuladoHistorico + netUSD,
      // Total explícito en USD del día (ventas brutas, antes de descuentos/devoluciones).
      // Se calcula como suma de v.totalUSD: cada venta ya tiene su total en USD
      // (los pagos en BS se convierten internamente con la tasa del momento).
      // Esto es lo que el usuario pidió agregar a los Reportes X/Z.
      totalVentasUSD: brUSD,
      metodosArqueo,
      ventasCreditoUSD,
      estimadoEfectivoBS,
      estimadoEfectivoUSD,
      tasaBCV: state.tasa || 0
    };
  };

  const [reportLoading, setReportLoading] = useState(false);
  const [reportLoadingType, setReportLoadingType] = useState<'REPORT_X' | 'REPORT_Z' | null>(null);

  const handleOpenReport = async (type: 'REPORT_X' | 'REPORT_Z') => {
    // Si el reporte ya está abierto, no hacer nada.
    if (showReportType) return;
    setReportLoading(true);
    setReportLoadingType(type);
    try {
      // Garantiza que ventas/devoluciones/libroDiario/etc. estén cargados
      // desde Firestore antes de calcular. Evita el bug de "$0" tras reinicio
      // o corte de luz, donde el cache aún no terminó de hidratarse.
      const freshBeforeReport = Store.get();
      const terminalCashBeforeReport = Utils.getTerminalCash(currentTerminal);
      const lastZBeforeReport = terminalCashBeforeReport.fechaUltimoZ || freshBeforeReport.fechaUltimoZ || '';
      let reportWindowStart = lastZBeforeReport;
      let reportWindowEndExclusive = '';
      
      // Recuperación de jornada omitida: si esta caja no tiene fecha de último Z,
      // el Z debe poder cerrar la jornada calendario anterior sin tragarse las ventas de hoy.
      if (type === 'REPORT_Z' && !lastZBeforeReport) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const previousDayStart = new Date(todayStart);
        previousDayStart.setDate(previousDayStart.getDate() - 1);
        reportWindowStart = previousDayStart.toISOString();
        reportWindowEndExclusive = todayStart.toISOString();
      }
      
      await Store.ensureReportData(currentTerminal?.id || 'GLOBAL', reportWindowStart || undefined);
      
      // Verificar que los datos se cargaron correctamente
      const state = Store.get();
      const ventasDelDia = (state.ventas || []).filter(v => v.estado !== 'anulada' && v.terminalId === (currentTerminal?.id || 'GLOBAL'));
      
      // Si no hay ventas pero isCashOpen es true, mostrar advertencia
      if (ventasDelDia.length === 0 && state.isCashOpen) {
        toast({ 
          variant: 'default', 
          title: 'Sin ventas registradas', 
          description: 'Las ventas aún se están sincronizando. Si el problema persiste, recarga la página.' 
        });
      }
      
      const data = getFreshReportData(reportWindowStart, reportWindowEndExclusive || undefined);
      setReportSnapshot(data);
      setShowReportType(type);
    } catch (e) {
      console.error('Error abriendo reporte X/Z:', e);
      const message = e instanceof Error ? e.message : String(e || 'Error desconocido');
      console.error('Detalle Reporte X/Z:', message);
      toast({ variant: 'destructive', title: 'Error', description: `No se pudieron cargar los datos del reporte: ${message}` });
    } finally {
      setReportLoading(false);
      setReportLoadingType(null);
    }
  };

  const ejecutarCierreZ = () => {
    const data = reportSnapshot;
    if (!data) return;
    const ahora = Utils.ahora();
    const numeroZ = state.ultimoZ + 1;
    const nuevoZ: ReportZ = {
      id: 'Z-' + String(numeroZ).padStart(6, '0'), fecha: ahora, numeroZ, terminalName: data.terminalName,
      desdeFactura: data.desdeFactura, hastaFactura: data.hastaFactura, desdeNotaCredito: data.desdeNC, hastaNotaCredito: data.hastaNC,
      cantidadAnuladas: data.stats.anulaciones, ventaBrutaUSD: data.brUSD, descuentoUSD: data.descUSD, devolucionesUSD: data.devUSD,
      ventaNetaUSD: data.netUSD, baseImponibleUSD: data.baseImponibleUSD, ivaUSD: data.ivaUSD, exentoUSD: data.exentoUSD,
      igtfUSD: data.igtfUSD, metodosPago: { ...data.paymentMethods }, salidasCajaUSD: data.manualSalidas, entradasCajaUSD: data.manualEntradas,
      fondoAperturaUSD: data.fondoAperturaUSD, fondoAperturaBS: data.fondoAperturaBS, acumuladoHistoricoUSD: data.acumuladoHistoricoUSD, stats: { ...data.stats }
    };
    
    if (typeof localStorage !== 'undefined') localStorage.removeItem('posven_apertura_done');

    const terminalId = currentTerminal?.id;
    const terminalesActualizadas = terminalId
      ? Utils.patchTerminal(state.terminales, terminalId, {
          ultimoZ: numeroZ,
          fechaUltimoZ: ahora,
          acumuladoHistorico: data.acumuladoHistoricoUSD,
          fondoCajaHoyBS: 0,
          fondoCajaHoyUSD: 0,
          isCashOpen: false,
          cashData: null
        })
      : state.terminales;

    updateState({
      reportesZ: [...(state.reportesZ || []), nuevoZ],
      terminales: terminalesActualizadas,
      ultimoZ: numeroZ,
      fechaUltimoZ: ahora,
      acumuladoHistorico: data.acumuladoHistoricoUSD,
      fondoCajaHoyBS: 0,
      fondoCajaHoyUSD: 0,
      isCashOpen: false
    });
    toast({ title: `Cierre Fiscal ${nuevoZ.id} Exitoso`, description: 'La jornada anterior quedó cerrada. La próxima apertura iniciará una nueva jornada.' });
    setShowReportType(null);
    setReportSnapshot(null);
  };

  const saldoActualDeuda = (debt: any) => {
    const monto = Math.max(0, Number(debt?.montoUSD) || 0);
    const saldoRegistrado = Math.max(0, Number(debt?.saldoUSD) || 0);
    const abonadoRegistrado = Math.max(0, Number(debt?.abonadoUSD) || 0);
    const abonadoHistorial = Array.isArray(debt?.historialPagos)
      ? debt.historialPagos.reduce((sum: number, p: any) => sum + Math.max(0, Number(p?.montoUSD) || 0), 0)
      : 0;
    const abonadoActual = Math.min(monto, Math.max(abonadoRegistrado, abonadoHistorial));
    return abonadoActual > 0.000001 ? Math.max(0, monto - abonadoActual) : saldoRegistrado;
  };

  const esDeudaActiva = (debt: any) =>
    (Number(debt?.montoUSD) || 0) > 0.001 &&
    saldoActualDeuda(debt) > 0.001 &&
    debt?.estado !== 'pagada';

  const groupedCredits = useMemo(() => {
    const groups: Record<string, { totalUSD: number; debts: Debt[] }> = {};
    (state.cxc || []).filter(esDeudaActiva).forEach(debt => {
      const name = debt.cliente || 'DESCONOCIDO';
      if (!groups[name]) groups[name] = { totalUSD: 0, debts: [] };
      groups[name].totalUSD += saldoActualDeuda(debt);
      groups[name].debts.push(debt);
    });
    return groups;
  }, [state.cxc]);

  const getStockDisponible = (p: Product) => {
    let avail = p.stock || 0;
    if (p.isKit && p.kitType === 'stock_componentes' && p.kitItems) {
      let compPossible = Infinity;
      p.kitItems.forEach(ki => {
        const cp = state.productos.find(c => c.id === ki.productoId);
        if (cp) compPossible = Math.min(compPossible, Math.floor((cp.stock || 0) / ki.cantidad));
        else compPossible = 0;
      });
      if (compPossible !== Infinity) avail = compPossible;
    }
    return avail;
  };

  const agregar = (pid: string) => {
    const p = state.productos.find(x => x.id === pid);
    if (!p) return;
    const stockAvail = getStockDisponible(p);
    if (stockAvail <= 0) {
      toast({ variant: "destructive", title: "Sin Stock" });
      return;
    }
    setSelectedProductDisplay(p);
    const nuevoCarrito = [...state.carrito];
    const idx = nuevoCarrito.findIndex(i => i.productoId === pid);
    if (idx >= 0) {
      if (nuevoCarrito[idx].cantidad >= stockAvail) return;
      nuevoCarrito[idx].cantidad++;
      nuevoCarrito[idx].subtotalUSD = nuevoCarrito[idx].cantidad * nuevoCarrito[idx].precioUnitUSD;
    } else {
      nuevoCarrito.push({ productoId: pid, nombre: p.nombre, precioUnitUSD: p.precioUSD, cantidad: 1, subtotalUSD: p.precioUSD });
    }
    updateState({ carrito: nuevoCarrito });
    setSearch('');
    setPagos([]);
    searchInputRef.current?.focus();
  };

  const updateQty = (idx: number, delta: number) => {
    const nuevo = [...state.carrito];
    const item = nuevo[idx];
    const p = state.productos.find(x => x.id === item.productoId);
    if (!p) return;
    setSelectedProductDisplay(p);
    const stockAvail = getStockDisponible(p);
    const n = item.cantidad + delta;
    if (n <= 0) nuevo.splice(idx, 1);
    else if (n <= stockAvail) {
      item.cantidad = n;
      item.subtotalUSD = n * item.precioUnitUSD;
    }
    updateState({ carrito: nuevo });
    setPagos([]);
  };

  const handlePriceChange = (index: number, newPrice: number) => {
    const nuevo = [...state.carrito];
    nuevo[index].precioUnitUSD = newPrice;
    nuevo[index].subtotalUSD = nuevo[index].cantidad * newPrice;
    updateState({ carrito: nuevo });
    setPriceSelectorItem(null);
    toast({ title: "Precio Actualizado", description: `Nuevo precio: ${Utils.fmtUSD(newPrice)}` });
  };

  const subtotalUSD = state.carrito.reduce((s, i) => s + i.subtotalUSD, 0);
  const totalBS = subtotalUSD * state.tasa;
  const totalPagadoUSD = pagos.reduce((s, p) => s + p.montoUSD, 0);
  const saldoRestanteUSD = Math.max(0, subtotalUSD - totalPagadoUSD);

  const matches = search.trim().length > 0 
    ? state.productos.filter(p => p.activo && (p.nombre.toLowerCase().includes(search.toLowerCase()) || p.codigo.toLowerCase().includes(search.toLowerCase()))).slice(0, 8)
    : [];

  const filteredClients = useMemo(() => {
    if (clientSearch.trim().length === 0) return [];
    const searchLower = clientSearch.toLowerCase();
    const searchNumeric = clientSearch.replace(/\D/g, '');

    return (state.clientes || []).filter(c => {
      const nameMatch = (c.name || '').toLowerCase().includes(searchLower);
      const cedulaExactMatch = (c.cedula || '').toLowerCase().includes(searchLower);
      const cedulaNumericMatch = searchNumeric.length > 0 && (c.cedula || '').replace(/\D/g, '').includes(searchNumeric);

      return nameMatch || cedulaExactMatch || cedulaNumericMatch;
    });
  }, [clientSearch, state.clientes]);

  const getCurrentTerminal = () => currentTerminal;
  const handleOpenGlobalCreditPayment = (clientName: string, debts: Debt[]) => {
    const activeDebts = debts.filter(esDeudaActiva).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id));
    if (activeDebts.length <= 1) return;
    const totalUSD = activeDebts.reduce((sum, d) => sum + saldoActualDeuda(d), 0);
    if (totalUSD <= 0.001) return;
    const cedulaMatch = String(activeDebts[0]?.cliente || '').match(/\[([^\]]+)\]\s*$/);
    setGlobalCreditCustomer({
      name: clientName,
      cedula: cedulaMatch?.[1]?.trim(),
      totalUSD,
      totalBS: totalUSD * state.tasa
    });
  };

  const handleProcessGlobalCreditPayment = async (payments: any[]) => {
    if (!globalCreditCustomer || isProcessing || processingRef.current) return;
    const totalUSD = payments.reduce((s, p) => s + (Number(p.usdAmount) || (Number(p.amount) || 0) / state.tasa), 0);
    const totalBS = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (totalUSD <= 0 || totalBS <= 0) return;

    processingRef.current = true;
    setIsProcessing(true);
    try {
      const ahora = Utils.ahora();
      const terminal = getCurrentTerminal();
      const reciboProvisional = 'PEND-CXC-' + Store.uid().toUpperCase().slice(0, 8);
      const pagoBase = {
        id: reciboProvisional,
        fecha: ahora,
        montoUSD: totalUSD,
        montoBS: totalBS,
        metodo: payments.length > 1 ? 'mixto' : payments[0].method,
        reciboId: reciboProvisional,
        tasaAplicada: state.tasa
      };
      const asientoId = 'ACC-' + Store.uid().toUpperCase().slice(0, 5);
      const journal = {
        id: asientoId,
        fecha: ahora,
        tipo: 'ingreso',
        categoria: 'COBRO_DEUDA',
        concepto: `PAGO GLOBAL CXC: ${globalCreditCustomer.name.toUpperCase()} - LIQUIDACIÓN POR ORDEN DE ANTIGÜEDAD`,
        montoUSD: totalUSD,
        montoBS: totalBS,
        metodo: pagoBase.metodo,
        referencia: reciboProvisional,
        terminalId: terminal?.id,
        terminalName: terminal?.nombre || 'SISTEMA GLOBAL'
      };

      const resultado = await Store.applyGlobalCustomerPaymentTransaction({
        operationId: 'PAGO-GLOBAL-CXC-' + Store.uid(),
        customerName: globalCreditCustomer.name,
        customerCedula: globalCreditCustomer.cedula,
        amountUSD: totalUSD,
        amountBS: totalBS,
        payment: pagoBase,
        journal,
        terminalId: terminal?.id
      });

      if (!resultado || resultado.appliedUSD <= 0.000001) {
        throw new Error('No hay saldo pendiente del cliente o la información cambió en otra caja.');
      }

      const aplicadoBS = Number(resultado.appliedBS) || 0;
      const remanenteUSD = Math.max(0, totalUSD - Number(resultado.appliedUSD || 0));
      toast({
        title: 'Pago global registrado',
        description: `${Utils.fmtUSD(resultado.appliedUSD)} (${Utils.fmtBS(aplicadoBS)}) aplicado a ${resultado.debts.length} factura(s)${remanenteUSD > 0.000001 ? ' · excedente sin aplicar' : ''}.`
      });
      setGlobalCreditCustomer(null);
    } catch (e: any) {
      toast({
        variant: 'destructive',
        title: 'No se pudo registrar el pago global',
        description: e?.message || 'Las cuentas cambiaron en otra caja. Actualice y vuelva a intentar.'
      });
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
    }
  };


  const guardarNuevaTasa = () => {
    const n = parseFloat(nuevaTasa);
    if (isNaN(n) || n <= 0) return alert('Tasa inválida');
    updateState({ tasa: n });
    setEditandoTasa(false);
  };

  const ejecutarVenta = async (pagosFinales?: PagoRealizado[]) => {
    if (state.carrito.length === 0 || isProcessing || processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    try {
      const listadoPagos = pagosFinales || pagos;
      const totalPagadoRecibido = listadoPagos.reduce((s, p) => s + p.montoUSD, 0);
      const terminal = getCurrentTerminal();
      const ahoraStr = Utils.ahora();

      const operationId = 'VENTA-' + Store.uid();
      const resultado = await Store.createSaleTransaction({
        operationId,
        cart: state.carrito,
        payments: listadoPagos,
        clientName: cliente,
        terminalId: terminal?.id,
        fallbackReceiptNumber: terminal?.proximoRecibo || state.proximoRecibo,
        now: ahoraStr,
        tasa: state.tasa,
        saleType: 'VENTA',
        cajeroId: auth?.currentUser?.uid
      });

      if (!resultado?.sale) throw new Error('No se pudo registrar la venta.');

      if (resultado.queuedOffline) {
        updateState({ carrito: [] });
        setPagos([]);
        setCliente('Consumidor final');
        setSelectedProductDisplay(null);
        toast({
          title: 'Venta guardada sin conexión',
          description: 'La venta quedó pendiente y se enviará automáticamente a la base de datos al regresar Internet. No se emitió un comprobante fiscal definitivo.'
        });
        return;
      }

      // El correlativo, inventario y movimientos ya fueron confirmados en Firestore.
      // Aquí solo limpiamos el carrito local; los datos autoritativos llegan por snapshots.
      updateState({ carrito: [] });
      setLastProcessedSale(resultado.sale);
      setShowReceiptModal(true);
      setPagos([]);
      setCliente('Consumidor final');
      setSelectedProductDisplay(null);
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Venta no registrada',
        description: err?.message || 'La operación fue rechazada para proteger el inventario.'
      });
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
    }
  };

  const ejecutarAbono = async (pagosAbono: PagoRealizado[]) => {
    if (!showAbonoModal || isProcessing || processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    try {
      const totalAbonado = pagosAbono.reduce((s, p) => s + p.montoUSD, 0);
      const totalAbonadoBS = pagosAbono.reduce((s, p) => s + (Number(p.montoBS) || 0), 0);
      if (totalAbonado <= 0 || totalAbonadoBS <= 0) return;

      // La deuda histórica puede conservar un nombre antiguo. La identidad
      // operativa se resuelve por la cédula embebida en "cliente" y se contrasta
      // con el catálogo actual de clientes antes de generar el cobro.
      const clienteRaw = showAbonoModal.cliente || '';
      const cedulaMatch = clienteRaw.match(/\[([^\]]+)\]\s*$/);
      const cedulaDeuda = cedulaMatch?.[1]?.trim();
      const clienteActual = cedulaDeuda
        ? (state.clientes || []).find(c => c.cedula === cedulaDeuda || c.cedula.replace(/[^0-9A-Za-z]/g, '') === cedulaDeuda.replace(/[^0-9A-Za-z]/g, ''))
        : undefined;
      const nombreClienteCanonico = clienteActual?.name || (cedulaMatch ? clienteRaw.replace(/\s*\[[^\]]+\]\s*$/, '').trim() : clienteRaw) || 'CLIENTE';
      const ahoraStr = Utils.ahora(), terminal = getCurrentTerminal();
      // El correlativo de COBRO DE DEUDA lo asigna Firestore dentro de la
      // transacción, usando la secuencia exclusiva de esta caja.
      const reciboProvisional = 'PEND-CXC-' + Store.uid().toUpperCase().slice(0, 8);
      const pagoAtomic = {
        fecha: ahoraStr,
        montoUSD: totalAbonado,
        montoBS: totalAbonado * state.tasa,
        metodo: pagosAbono.length > 1 ? 'mixto' : pagosAbono[0].metodo,
        reciboId: reciboProvisional
      };

      const nuevasEntradasDiario: LibroDiarioEntry[] = pagosAbono.map(p => ({ id: 'ACC-' + Store.uid().toUpperCase().slice(0, 5), fecha: ahoraStr, tipo: 'ingreso', categoria: 'COBRO_DEUDA', concepto: `ABONO DEUDA #${showAbonoModal.id} - CLIENTE: ${nombreClienteCanonico.toUpperCase()}`, montoUSD: p.montoUSD, montoBS: p.montoBS, metodo: p.metodo, referencia: reciboProvisional, terminalId: terminal?.id, terminalName: terminal?.nombre }));

      const saleAbono: Sale = {
        id: reciboProvisional, fecha: ahoraStr, cliente: nombreClienteCanonico,
        items: [{ productoId: 'ABONO', nombre: `ABONO A FACTURA #${showAbonoModal.id}`, cantidad: 1, precioUnitUSD: totalAbonado, subtotalUSD: totalAbonado }],
        subtotalUSD: totalAbonado, descuentoUSD: 0, totalUSD: totalAbonado, totalBS: totalAbonado * state.tasa,
        metodoPago: pagosAbono.length > 1 ? 'mixto' : pagosAbono[0].metodo,
        estado: 'completada', type: 'COBRO DEUDA', payments: [...pagosAbono],
        terminalId: terminal?.id, terminalName: terminal?.nombre || 'SISTEMA GLOBAL', tasa: state.tasa
      };

      const clienteCedula = cedulaDeuda;
      const resultadoPago = await Store.applyDebtPaymentTransaction({
        collection: 'cxc',
        debtId: showAbonoModal.id,
        amountUSD: totalAbonado,
        amountBS: totalAbonadoBS,
        payment: pagoAtomic,
        journal: nuevasEntradasDiario,
        sale: saleAbono,
        customerCedula: clienteCedula,
        terminalId: terminal?.id
      });
      if (!resultadoPago) throw new Error('No se pudo registrar el abono.');
      const appliedUSD = Number(resultadoPago.appliedUSD) || totalAbonado;
      if (Math.abs(appliedUSD - totalAbonado) > 0.001) throw new Error('El saldo cambió mientras se registraba el abono. La operación fue limitada al saldo real.');

      const saleFinal = resultadoPago.sale || { ...saleAbono, id: resultadoPago.receiptId || saleAbono.id };
      setLastProcessedSale(saleFinal); setShowReceiptModal(true); setShowAbonoModal(null);
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Abono no registrado',
        description: err?.message || 'No se pudo registrar el abono. El saldo no fue modificado.'
      });
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
    }
  };

  const ejecutarVentaACredito = async () => {
    if (state.carrito.length === 0 || isProcessing || processingRef.current) return;

    let targetClient: Customer | null = selectedClient;
    let createNewClient = false;

    if (showNewClientForm) {
      if (!newClient.name || !newClient.cedula) return alert("Datos incompletos.");
      const fullId = `${newClient.tipoDoc}-${newClient.cedula}`;
      targetClient = {
        id: Store.uid(),
        name: newClient.name.toUpperCase(),
        cedula: fullId,
        phone: newClient.phone,
        address: newClient.address,
        debt: 0
      };
      createNewClient = true;
    }

    if (!targetClient) return alert("Seleccione un cliente.");

    processingRef.current = true;
    setIsProcessing(true);
    try {
      const terminal = getCurrentTerminal();
      const ahoraStr = Utils.ahora();
      const fallbackNumber = terminal?.proximoRecibo || state.proximoRecibo;
      const debtId = 'CRD-' + String(fallbackNumber).padStart(9, '0');

      const resultado = await Store.createSaleTransaction({
        cart: state.carrito,
        payments: [],
        clientName: targetClient.name,
        terminalId: terminal?.id,
        fallbackReceiptNumber: fallbackNumber,
        now: ahoraStr,
        tasa: state.tasa,
        saleType: 'VENTA CRÉDITO',
        cajeroId: auth?.currentUser?.uid,
        credit: {
          customer: targetClient,
          debtId
        }
      });

      if (!resultado?.sale || !resultado?.debt) throw new Error('No se pudo registrar la venta a crédito.');

      updateState({ carrito: [] });
      setLastProcessedSale(resultado.sale);
      setShowReceiptModal(true);
      setIsCreditView(false);
      setSelectedClient(null);
      if (createNewClient) {
        setShowNewClientForm(false);
        setNewClient({ name: '', tipoDoc: 'V', cedula: '', phone: '', address: '' });
      }
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Crédito no registrado',
        description: err?.message || 'La operación fue rechazada para proteger inventario y cuenta por cobrar.'
      });
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 h-[calc(100vh-100px)] max-w-7xl mx-auto w-full overflow-hidden">
      <div className="flex gap-2 no-print shrink-0 overflow-x-auto pb-1 items-center">
        <button onClick={() => setView('pos')} className={`btn btn-sm ${view === 'pos' ? 'btn-primary shadow-md' : 'bg-white text-ink font-bold border-line border'}`}><ShoppingCart className="w-3.5 h-3.5"/> Punto de Venta</button>
        <button onClick={() => setView('history')} className={`btn btn-sm ${view === 'history' ? 'btn-primary shadow-md' : 'bg-white text-ink font-bold border-line border'}`}><History className="w-3.5 h-3.5"/> Historial</button>
        <button onClick={() => setView('credits')} className={`btn btn-sm ${view === 'credits' ? 'btn-primary shadow-md' : 'bg-white text-ink font-bold border-line border'}`}><ClipboardList className="w-3.5 h-3.5"/> Consultar Créditos</button>
        <button onClick={() => handleOpenReport('REPORT_X')} disabled={reportLoading} className="btn btn-sm bg-white text-ink font-bold border-line border disabled:opacity-50"><FileText className="w-3.5 h-3.5"/> {reportLoadingType === 'REPORT_X' ? 'Cargando…' : 'Reporte X'}</button>
        <button onClick={() => handleOpenReport('REPORT_Z')} disabled={reportLoading} className="btn btn-sm bg-white text-ink font-bold border-line border disabled:opacity-50"><Receipt className="w-3.5 h-3.5"/> {reportLoadingType === 'REPORT_Z' ? 'Cargando…' : 'Reporte Z'}</button>
        <button onClick={() => setView('returns')} className={`btn btn-sm ${view === 'returns' ? 'btn-primary shadow-md' : 'bg-white text-ink font-bold border-line border'}`}><RotateCcw className="w-3.5 h-3.5"/> Devoluciones y Anulaciones</button>
        
        {view === 'pos' && (
          <button 
            onClick={() => setIsFullScreen(!isFullScreen)} 
            className="btn btn-sm bg-white text-ink font-bold border-line border ml-auto hover:bg-brand-gold-soft transition-colors"
            title={isFullScreen ? "Minimizar" : "Expandir Pantalla Completa"}
          >
            {isFullScreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {view === 'pos' ? (
        <div className={cn(
          "flex flex-col gap-2 flex-1 overflow-hidden animate-in fade-in duration-300",
          isFullScreen && "fixed inset-0 z-[100] bg-surface-warm p-6 overflow-hidden flex flex-col"
        )}>
          <div className="flex items-center gap-3 shrink-0 mb-1">
            <div className="relative group flex-1">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#c8952e] z-10"><Barcode className="w-5 h-5" /></div>
              <input ref={searchInputRef} className="form-input pl-14 py-2 text-base bg-white border-brand-gold/30 text-ink font-black placeholder-ink/40" placeholder="Escanee o busque producto..." value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && matches.length >= 1) agregar(matches[0].id); else if (e.key === 'Escape') setSearch(''); }} autoFocus />
              {matches.length > 0 && (
                <div className="absolute top-full left-0 right-0 bg-white border border-line rounded-b-lg shadow-2xl z-[100] mt-1 overflow-hidden">
                  {matches.map(p => (
                    <div key={p.id} onClick={() => agregar(p.id)} className="flex items-center justify-between p-3 hover:bg-brand-gold/10 cursor-pointer border-b border-line group">
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-ink text-sm font-black uppercase truncate group-hover:text-brand-gold-deep transition-colors">{p.nombre}</span>
                        <span className="text-ink/60 text-[10px] mono font-bold">{p.codigo}</span>
                      </div>
                      <div className="flex items-center gap-10 shrink-0 ml-4">
                         <div className="flex flex-col items-end min-w-[70px]"><span className="text-[9px] font-black uppercase text-ink/40 mb-0.5">Stock</span><span className={`text-lg font-black leading-none ${p.stock <= (p.stockMinimo || 3) ? 'text-red-600' : p.stock <= (p.stockMinimo || 3) * 2 ? 'text-amber-500' : 'text-green-600'}`}>{p.stock} <span className="text-[10px] opacity-60">Und.</span></span></div>
                         <div className="flex items-center gap-2"><div className="flex flex-col items-end min-w-[90px]"><span className="text-[9px] font-black uppercase text-ink/40 mb-0.5">Precio USD</span><span className="text-lg font-black leading-none text-ink">{Utils.fmtUSD(p.precioUSD)}</span></div><div className="flex flex-col items-end min-w-[110px]"><span className="text-[9px] font-black uppercase text-ink/40 mb-0.5">Equiv. BS</span><span className="text-lg font-black leading-none text-brand-gold-deep">{Utils.fmtBS(p.precioUSD * state.tasa)}</span></div></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 bg-white px-4 py-1.5 rounded-full border border-brand-gold/30 shadow-sm shrink-0">
              <div className="w-8 h-8 rounded-full overflow-hidden border border-line shrink-0"><img src="/bcv-logo.png" alt="BCV" className="w-full h-full object-cover" /></div>
              <div className="flex items-center gap-1.5">{!editandoTasa ? (<><span className="text-ink font-black text-sm tabular-nums">{state.tasa.toFixed(2)}</span><button onClick={() => { setEditandoTasa(true); setNuevaTasa(state.tasa.toString()); }} className="text-brand-gold hover:text-brand-gold-deep p-0.5 transition-colors"><RefreshCw className="w-3.5 h-3.5" /></button></>) : (<><input type="text" value={nuevaTasa} onChange={e => setNuevaTasa(e.target.value.replace(/[^0-9.]/g, ''))} className="w-16 bg-surface-soft border border-brand-gold rounded px-1.5 py-0.5 text-ink font-black text-sm text-right outline-none" autoFocus /><button onClick={guardarNuevaTasa} className="text-status-success p-0.5"><Check className="w-4 h-4" /></button><button onClick={() => setEditandoTasa(false)} className="text-status-danger p-0.5"><X className="w-4 h-4" /></button></>)}</div>
            </div>
          </div>

          <div className="flex flex-1 gap-3 overflow-hidden">
            <div className="w-1/4 flex flex-col gap-2">
              <div className="card p-3 space-y-3 bg-white border-line h-full flex flex-col">
                <div className="form-group mb-0">
                  <label className="text-ink text-[10px] font-black uppercase block mb-1">IDENTIFICACIÓN CLIENTE</label>
                  <input className="form-input h-8 text-xs bg-surface-soft text-ink border-line font-black uppercase" value={cliente} onChange={e => setCliente(e.target.value)} />
                </div>

                <div className="flex-1 overflow-y-auto space-y-2 pt-2 border-t border-line/10">
                  {selectedProductDisplay && (
                    <div className="space-y-3 animate-in slide-in-from-bottom-2 duration-300">
                       <div className="p-3 bg-surface-soft border border-line rounded-xl text-center"><span className="text-[9px] font-black uppercase text-ink opacity-40 block mb-1">STOCK DISPONIBLE</span><span className={`text-2xl font-black ${selectedProductDisplay.stock <= (selectedProductDisplay.stockMinimo || 3) ? 'text-status-danger' : selectedProductDisplay.stock <= (selectedProductDisplay.stockMinimo || 3) * 2 ? 'text-status-warn' : 'text-status-success'}`}>{selectedProductDisplay.stock} <span className="text-xs">UND</span></span></div>
                       <div className="p-3 bg-surface-soft border border-line rounded-xl text-center"><span className="text-[9px] font-black uppercase text-ink opacity-40 block mb-1">PRECIO UNITARIO USD</span><span className="text-2xl font-black text-ink">{Utils.fmtUSD(selectedProductDisplay.precioUSD)}</span></div>
                       <div className="p-3 bg-brand-gold-soft/30 border border-brand-gold-soft/30 rounded-xl text-center"><span className="text-[9px] font-black uppercase text-brand-gold-deep block mb-1">EQUIVALENTE EN BOLÍVARES</span><span className="text-2xl font-black text-brand-gold-deep">{Utils.fmtBS(selectedProductDisplay.precioUSD * state.tasa)}</span></div>
                    </div>
                  )}
                  {state.carrito.length > 0 && (
                    <button onClick={() => setIsCreditView(true)} className="w-full h-10 border-2 border-status-info text-status-info hover:bg-status-info-soft font-black uppercase text-[10px] rounded-xl transition-all mt-4">Cargar a Crédito</button>
                  )}
                </div>
              </div>
            </div>

            <div className="w-3/4 flex flex-col gap-2 overflow-hidden">
              <div className="card flex-1 flex flex-col overflow-hidden bg-white border-none shadow-xl">
                <div className="grid grid-cols-[1fr_80px_70px_35px_80px_80px_80px_35px] gap-1 px-3 py-3 bg-ink text-white text-[10px] font-black uppercase tracking-[0.12em] rounded-t-lg">
                  <div>Descripción</div><div className="text-center">Cant</div><div className="text-center">U.M.</div><div /> <div className="text-right">Precio ($)</div><div className="text-right">Precio (Bs)</div><div className="text-right">Total</div><div className="text-center"></div>
                </div>
                <div className="flex-1 overflow-y-auto p-1 space-y-1">
                  {state.carrito.map((item, i) => {
                    const prod = state.productos.find(p => p.id === item.productoId);
                    return (
                      <div key={i} className="grid grid-cols-[1fr_80px_70px_35px_80px_80px_80px_35px] gap-1 items-center px-3 py-3 bg-white border-b border-black/5 text-ink">
                        <div className="truncate font-black text-xs uppercase leading-tight">{item.nombre}</div>
                        <div className="flex items-center justify-center gap-1 bg-surface-soft rounded p-0.5 border border-line/30"><button onClick={() => updateQty(i, -1)} className="text-ink font-black text-sm px-1.5">-</button><span className="w-5 text-center text-xs font-black">{item.cantidad}</span><button onClick={() => updateQty(i, 1)} className="text-ink font-black text-sm px-1.5">+</button></div>
                        <div className="text-center text-[10px] font-black uppercase">{prod?.cantidad || '-'}</div>
                        <div className="flex justify-center">
                          <button 
                            onClick={() => prod && setPriceSelectorItem({ index: i, product: prod })}
                            className="text-brand-gold hover:text-brand-gold-deep transition-colors p-1 bg-brand-gold-soft/20 rounded-md"
                            title="Cambiar Precio (Alternativos)"
                          >
                            <Tag className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="text-right text-xs font-black">{Utils.fmtUSD(item.precioUnitUSD)}</div>
                        <div className="text-right text-xs font-black">{Utils.fmtBS(item.precioUnitUSD * state.tasa)}</div>
                        <div className="text-right text-sm font-black">{Utils.fmtUSD(item.subtotalUSD)}</div>
                        <div className="flex justify-center"><button onClick={() => updateQty(i, -item.cantidad)} className="text-ink/20 hover:text-red-600"><Trash2 className="w-4 h-4"/></button></div>
                      </div>
                    );
                  })}
                </div>
                <div className="p-4 bg-ink border-t border-line/10 flex items-center justify-between rounded-b-lg gap-6">
                  <div className="space-y-0 shrink-0"><label className="text-white/60 text-[8px] font-black uppercase block tracking-widest mb-1">TOTAL FACTURA</label><div className="text-4xl font-black text-brand-gold leading-none">{Utils.fmtUSD(subtotalUSD)}</div></div>
                  <div className="flex-1 flex justify-end items-center pr-4"><div className="text-4xl font-black text-white">{Utils.fmtBS(totalBS)}</div></div>
                  
                  <div className="flex items-center gap-3">
                    {isFullScreen && (
                      <button 
                        onClick={() => setIsFullScreen(false)} 
                        className="w-14 h-14 bg-white/10 border-2 border-white/20 text-white rounded-full flex items-center justify-center hover:bg-white/20 transition-all transform hover:scale-105"
                        title="Minimizar (ESC)"
                      >
                        <Minimize2 className="w-6 h-6" />
                      </button>
                    )}
                    <button onClick={() => saldoRestanteUSD <= 0.01 && state.carrito.length > 0 ? ejecutarVenta() : setShowMultiModal(true)} disabled={state.carrito.length === 0 || isProcessing} className="w-14 h-14 bg-[#c8952e] text-black rounded-full shadow-lg flex items-center justify-center hover:bg-[#d9a540] transition-all transform hover:scale-105 active:scale-95 disabled:opacity-20 shrink-0">
                      {isProcessing ? <Loader2 className="w-8 h-8 animate-spin" /> : (saldoRestanteUSD <= 0.01 && state.carrito.length > 0 ? <Check className="w-8 h-8" /> : <Wallet className="w-8 h-8" />)}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : view === 'history' ? (
        <div className="card flex-1 bg-white flex flex-col overflow-hidden animate-in slide-in-from-bottom-2 duration-300 rounded-xl">
          <div className="card-head px-6 py-4 bg-ink border-b border-white/10 flex justify-between items-center"><h3 className="text-white font-black uppercase italic tracking-tighter flex items-center gap-2 text-xs"><History className="w-5 h-5 text-brand-gold" /> HISTORIAL TERMINAL: {currentTerminal?.nombre || 'S/T'}</h3><button onClick={() => setView('pos')} className="btn btn-sm bg-white text-ink hover:bg-surface-soft flex items-center gap-2 font-black uppercase text-[10px] rounded-lg border-none px-4"><ArrowLeft className="w-3.5 h-3.5"/> Volver al POS</button></div>
          <div className="table-wrap flex-1 overflow-y-auto">
            <table>
              <thead><tr><th>Recibo</th><th>Hora</th><th>Terminal</th><th>Cliente</th><th>Tipo</th><th className="text-right">Monto USD</th><th>Método</th><th className="text-center">Estado</th></tr></thead>
              <tbody>
                {(state.ventas || []).filter(v => v.terminalId === currentTerminal?.id && v.fecha > (Utils.getTerminalCash(currentTerminal).fechaUltimoZ || state.fechaUltimoZ || '')).sort((a,b) => b.fecha.localeCompare(a.fecha)).map(v => (
                  <tr key={v.id} className="border-b border-line/40 hover:bg-surface-warm/20"><td className="text-ink font-black text-xs mono">{v.id}</td><td className="text-ink font-bold text-xs">{v.fecha.split('T')[1]?.slice(0, 5)}</td><td className="text-ink font-black text-[10px] uppercase">{v.terminalName || state.terminales.find(t => t.id === v.terminalId)?.nombre || '-'}</td><td className="text-ink font-black text-xs uppercase truncate max-w-[150px]">{v.cliente}</td><td className="text-ink font-black text-[9px] uppercase"><span className={`badge ${v.type === 'COBRO DEUDA' ? 'badge-info' : 'badge-neutral'}`}>{v.type || 'VENTA'}</span></td><td className="text-brand-gold-deep font-black text-xs text-right">{Utils.fmtUSD(v.totalUSD)}</td><td className="text-ink font-bold text-[10px] uppercase">{Utils.metodoLabel(v.metodoPago)}</td><td className="text-center"><span className={`badge ${v.estado === 'pendiente' ? 'badge-warn' : (v.estado === 'anulada' ? 'badge-err' : 'badge-ok')} font-black text-[9px] uppercase`}>{v.estado}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : view === 'credits' ? (
        <div className="card flex-1 bg-white flex flex-col overflow-hidden animate-in slide-in-from-bottom-2 duration-300 rounded-xl">
          <div className="card-head px-6 py-4 bg-ink border-b border-white/10 flex justify-between items-center"><h3 className="text-white font-black uppercase italic tracking-tighter flex items-center gap-2 text-xs"><ClipboardList className="w-5 h-5 text-brand-gold" /> CONSULTA CRÉDITOS Y COBRANZA (GLOBAL)</h3><button onClick={() => setView('pos')} className="btn btn-sm bg-white text-ink hover:bg-surface-soft flex items-center gap-2 font-black uppercase text-[10px] rounded-lg border-none px-4"><ArrowLeft className="w-3.5 h-3.5"/> Volver al POS</button></div>
          <div className="table-wrap flex-1 overflow-y-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-soft">
                  <th className="px-6 py-3"></th>
                  <th className="text-ink font-black text-[10px] uppercase">Cliente / Identificación</th>
                  <th className="text-ink font-black text-[10px] uppercase text-right">Documentos</th>
                  <th className="text-ink font-black text-[10px] uppercase text-right">Saldo USD</th>
                  <th className="text-ink font-black text-[10px] uppercase text-right">Saldo BS</th>
                  <th className="text-ink font-black text-[10px] uppercase text-center">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(groupedCredits).length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-20 text-ink font-black uppercase italic">No hay deudas registradas</td></tr>
                ) : (
                  Object.entries(groupedCredits).map(([clientName, group]) => (
                    <React.Fragment key={clientName}>
                      <tr className="border-b border-line hover:bg-surface-warm/20 transition-colors">
                        <td className="px-6 py-4">
                           <button onClick={() => setExpandedClient(expandedClient === clientName ? null : clientName)} className="text-brand-gold hover:scale-110 transition-transform">{expandedClient === clientName ? <ChevronUp /> : <ChevronDown />}</button>
                        </td>
                        <td className="py-4"><div className="text-ink font-black text-sm uppercase">{clientName}</div></td>
                        <td className="text-right py-4 font-black text-ink">{group.debts.length} Facturas</td>
                        <td className="text-right py-4 font-black text-status-info text-base">{Utils.fmtUSD(group.totalUSD)}</td>
                        <td className="text-right py-4 font-black text-ink">{Utils.fmtBS(group.totalUSD * state.tasa)}</td>
                        <td className="text-center py-4">
                          <div className="flex items-center justify-center gap-2">
                            {group.debts.filter(esDeudaActiva).length > 1 && (
                              <button
                                onClick={() => handleOpenGlobalCreditPayment(clientName, group.debts)}
                                className="h-10 px-3 rounded-full flex items-center justify-center gap-1.5 bg-brand-gold text-black border-2 border-brand-gold hover:bg-brand-gold-deep transition-all shadow-md font-black text-[9px] uppercase whitespace-nowrap"
                                title="PAGO GLOBAL"
                                aria-label="PAGO GLOBAL"
                              >
                                <HandCoins className="w-4 h-4" />
                                <span>PAGO GLOBAL</span>
                              </button>
                            )}
                            <button onClick={() => setShowClientHistory(clientName)} className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-status-success border-2 border-status-success/20 hover:bg-status-success hover:text-white transition-all shadow-md" title="Consultar historial">
                              <Eye className="w-5 h-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedClient === clientName && (
                        <tr className="bg-surface-soft/40 animate-in slide-in-from-top-1 duration-200">
                           <td colSpan={6} className="px-12 py-4">
                              <div className="card border-line bg-white shadow-inner rounded-xl overflow-hidden">
                                 <table className="w-full">
                                    <thead className="bg-ink/5"><tr><th className="text-[9px] font-black uppercase p-2 text-left">Emisión</th><th className="text-[9px] font-black uppercase p-2 text-left">Vencimiento</th><th className="text-[9px] font-black uppercase p-2 text-right">Saldo USD</th><th className="text-[9px] font-black uppercase p-2 text-center">Acciones</th></tr></thead>
                                    <tbody>{group.debts.map(d => (<tr key={d.id} className="border-b border-line/20"><td className="text-[10px] font-black p-2">{Utils.fmtFecha(d.fecha)}</td><td className={`text-[10px] font-black p-2 ${d.fechaVencimiento < Utils.hoy() ? 'text-status-danger' : 'text-ink'}`}>{d.fechaVencimiento === '2099-12-31' ? 'ABIERTA' : Utils.fmtFecha(d.fechaVencimiento)}</td><td className="text-[10px] font-black p-2 text-right text-brand-gold-deep">{Utils.fmtUSD(saldoActualDeuda(d))}</td><td className="p-2 text-center"><div className="flex justify-center gap-2"><button onClick={() => setShowDetails(d)} className="w-8 h-8 rounded-full flex items-center justify-center text-status-success hover:bg-status-success/10"><Eye className="w-4 h-4"/></button><button onClick={() => { setShowAbonoModal(d); }} className="btn btn-sm btn-primary h-7 px-3 text-[8px] uppercase">Abonar</button></div></td></tr>))}</tbody>
                                 </table>
                              </div>
                           </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <ReturnsModule state={state} updateState={updateState} onBackToPOS={() => setView('pos')} terminalId={currentTerminal?.id} />
      )}

      {priceSelectorItem && (
        <div className="modal show" style={{ zIndex: 120 }}><div className="modal-bg" onClick={() => setPriceSelectorItem(null)}></div>
          <div className="modal-box max-w-sm bg-white border-2 border-line rounded-2xl overflow-hidden shadow-2xl">
            <div className="modal-head py-3 px-5 border-b border-line bg-ink text-white flex justify-between items-center">
              <h3 className="font-black text-xs uppercase tracking-widest flex items-center gap-2">
                <Tag className="w-4 h-4 text-brand-gold" /> Selección de Tarifa
              </h3>
              <button onClick={() => setPriceSelectorItem(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="modal-body p-6 space-y-4">
               <p className="text-[10px] font-black uppercase text-ink/40 text-center tracking-tighter">{priceSelectorItem.product.nombre}</p>
               
               <div className="grid grid-cols-1 gap-2">
                  <button onClick={() => handlePriceChange(priceSelectorItem.index, priceSelectorItem.product.precioUSD)} className="flex justify-between items-center p-4 bg-surface-soft border border-line rounded-xl hover:border-brand-gold transition-all group">
                    <span className="text-xs font-black text-ink uppercase">Precio Estándar</span>
                    <span className="text-sm font-black text-ink group-hover:text-brand-gold-deep">{Utils.fmtUSD(priceSelectorItem.product.precioUSD)}</span>
                  </button>
                  
                  {priceSelectorItem.product.precioMayorUSD && priceSelectorItem.product.precioMayorUSD > 0 && (
                    <button onClick={() => handlePriceChange(priceSelectorItem.index, priceSelectorItem.product.precioMayorUSD!)} className="flex justify-between items-center p-4 bg-brand-gold-soft/20 border border-brand-gold/20 rounded-xl hover:border-brand-gold transition-all group">
                      <span className="text-xs font-black text-brand-gold-deep uppercase">Precio al Mayor</span>
                      <span className="text-sm font-black text-brand-gold-deep">{Utils.fmtUSD(priceSelectorItem.product.precioMayorUSD)}</span>
                    </button>
                  )}

                  {priceSelectorItem.product.precioOfertaUSD && priceSelectorItem.product.precioOfertaUSD > 0 && (
                    <button onClick={() => handlePriceChange(priceSelectorItem.index, priceSelectorItem.product.precioOfertaUSD!)} className="flex justify-between items-center p-4 bg-status-success-soft/20 border border-status-success/20 rounded-xl hover:border-status-success transition-all group">
                      <span className="text-xs font-black text-status-success uppercase">Precio Oferta</span>
                      <span className="text-sm font-black text-status-success">{Utils.fmtUSD(priceSelectorItem.product.precioOfertaUSD)}</span>
                    </button>
                  )}

                  {priceSelectorItem.product.precioPromoUSD && priceSelectorItem.product.precioPromoUSD > 0 && (
                    <button onClick={() => handlePriceChange(priceSelectorItem.index, priceSelectorItem.product.precioPromoUSD!)} className="flex justify-between items-center p-4 bg-status-info-soft/20 border border-status-info/20 rounded-xl hover:border-status-info transition-all group">
                      <span className="text-xs font-black text-status-info uppercase">Precio Promoción</span>
                      <span className="text-sm font-black text-status-info">{Utils.fmtUSD(priceSelectorItem.product.precioPromoUSD)}</span>
                    </button>
                  )}
               </div>
            </div>
          </div>
        </div>
      )}

      {showReceiptModal && (<ReceiptModal isOpen={showReceiptModal} onClose={() => { setShowReceiptModal(false); setLastProcessedSale(null); }} saleData={lastProcessedSale} type="SALE" />)}
      {showReportType && reportSnapshot && (<ReceiptModal isOpen={!!showReportType} onClose={() => { if (showReportType === 'REPORT_Z') ejecutarCierreZ(); setShowReportType(null); }} reportData={reportSnapshot} type={showReportType} />)}
      {showMultiModal && (<FloatingPaymentModal total={totalBS} totalCents={Math.round(totalBS * 100)} exchangeRate={state.tasa} onClose={() => setShowMultiModal(false)} onConfirm={(data) => { ejecutarVenta(data.payments.map(p => ({ metodo: p.method as PaymentMethod, montoUSD: p.usdAmount || (p.amount / state.tasa), montoBS: p.amount }))); setShowMultiModal(false); }} />)}
      {showAbonoModal && (<FloatingPaymentModal total={saldoActualDeuda(showAbonoModal) * state.tasa} totalCents={Math.round(saldoActualDeuda(showAbonoModal) * state.tasa * 100)} exchangeRate={state.tasa} onClose={() => setShowAbonoModal(null)} allowPartial={true} onConfirm={(data) => { ejecutarAbono(data.payments.map(p => ({ metodo: p.method as PaymentMethod, montoUSD: p.usdAmount || (p.amount / state.tasa), montoBS: p.amount }))); }} />)}
      {globalCreditCustomer && (
        <FloatingPaymentModal
          total={globalCreditCustomer.totalBS}
          totalCents={Math.round(globalCreditCustomer.totalBS * 100)}
          exchangeRate={state.tasa}
          allowPartial={true}
          onClose={() => setGlobalCreditCustomer(null)}
          onConfirm={(data) => { void handleProcessGlobalCreditPayment(data.payments); }}
        />
      )}

      {showDetails && (
        <div className="modal show" style={{ zIndex: 110 }}><div className="modal-bg" onClick={() => setShowDetails(null)}></div>
          <div className="modal-box max-w-[600px] bg-white border-2 border-line rounded-xl overflow-hidden shadow-2xl">
            <div className="modal-head py-4 px-6 border-b border-line bg-ink flex justify-between items-center text-white">
              <h3 className="font-black text-xs uppercase italic tracking-tighter flex items-center gap-2">
                <Receipt className="w-5 h-5 text-brand-gold" /> HISTORIAL DETALLADO: {showDetails.id}
              </h3>
              <button onClick={() => setShowDetails(null)} className="text-white hover:text-brand-gold"><X className="w-5 h-5"/></button>
            </div>
            <div className="modal-body p-6 space-y-6 max-h-[75vh] overflow-y-auto bg-white">
              <div className="grid grid-cols-2 gap-4">
                 <div className="p-3 bg-surface-soft rounded-lg border border-line">
                    <label className="text-[8px] font-black uppercase text-ink block mb-1">Monto Original</label>
                    <p className="text-lg font-black text-ink">{Utils.fmtUSD(showDetails.montoUSD)}</p>
                 </div>
                 <div className="p-3 bg-brand-gold-soft border border-brand-gold/20 rounded-lg">
                    <label className="text-[8px] font-black uppercase text-brand-gold-deep block mb-1">Saldo Actual</label>
                    <p className="text-lg font-black text-brand-gold-deep">{Utils.fmtUSD(saldoActualDeuda(showDetails))}</p>
                 </div>
              </div>

              {(() => {
                const sale = state.ventas.find(v => v.id === showDetails.ventaId || v.id === showDetails.id);
                if (!sale) return null;
                return (
                  <div className="space-y-3 animate-in slide-in-from-top-2 duration-300">
                    <div className="flex justify-between items-center border-b border-line pb-2">
                       <h4 className="text-[10px] font-black uppercase text-ink tracking-[0.2em]">DETALLE DE COMPRA ORIGINAL</h4>
                       <span className="text-[9px] font-black text-ink uppercase">{Utils.fmtFecha(sale.fecha)}</span>
                    </div>
                    <div className="bg-surface-soft/50 rounded-lg overflow-hidden border border-line/30">
                       <table className="w-full">
                          <thead>
                            <tr className="bg-ink/5">
                               <th className="text-[8px] font-black uppercase p-2 text-left">Cant</th>
                               <th className="text-[8px] font-black uppercase p-2 text-left">Descripción</th>
                               <th className="text-[8px] font-black uppercase p-2 text-right">P. Unit</th>
                               <th className="text-[8px] font-black uppercase p-2 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sale.items.map((it: any, idx: number) => (
                              <tr key={idx} className="border-b border-line/20">
                                 <td className="text-[9px] font-black p-2">{it.cantidad}</td>
                                 <td className="text-[9px] font-black uppercase p-2 truncate max-w-[180px]">{it.nombre}</td>
                                 <td className="text-[9px] font-black p-2 text-right">{Utils.fmtUSD(it.precioUnitUSD)}</td>
                                 <td className="text-[9px] font-black p-2 text-right text-brand-gold-deep">{Utils.fmtUSD(it.subtotalUSD)}</td>
                              </tr>
                            ))}
                          </tbody>
                       </table>
                    </div>
                  </div>
                );
              })()}

              <div className="space-y-3">
                 <h4 className="text-[10px] font-black uppercase text-ink tracking-[0.2em] border-b border-line pb-2">CRONOLOGÍA DE ABONOS</h4>
                 <div className="max-h-[200px] overflow-y-auto space-y-2 pr-1">
                    {(!showDetails.historialPagos || showDetails.historialPagos.length === 0) ? (
                      <div className="py-10 text-center text-ink font-black uppercase italic text-[10px]">No se han registrado abonos aún</div>
                    ) : (
                      showDetails.historialPagos.map((p: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center p-3 bg-surface-soft border border-line rounded-lg">
                           <div className="space-y-0.5">
                              <p className="text-[10px] font-black text-ink uppercase">{Utils.fmtFecha(p.fecha)}</p>
                              <p className="text-[8px] font-black text-ink mono">REF: {p.reciboId}</p>
                           </div>
                           <div className="text-right">
                              <p className="text-xs font-black text-status-success">+{Utils.fmtUSD(p.montoUSD)}</p>
                              <p className="text-[8px] font-black text-ink uppercase">{Utils.metodoLabel(p.metodo || 'otros')}</p>
                           </div>
                        </div>
                      ))
                    )}
                 </div>
              </div>
            </div>
            <div className="modal-foot p-4 bg-surface-soft border-t border-line text-right">
               <button onClick={() => setShowDetails(null)} className="btn btn-primary px-8 font-black uppercase text-[10px] rounded-lg shadow-md">Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {showClientHistory && (
        <div className="modal show" style={{ zIndex: 105 }}><div className="modal-bg" onClick={() => setShowClientHistory(null)}></div>
          <div className={`modal-box max-w-4xl bg-white border-2 border-line rounded-xl overflow-hidden shadow-2xl transition-all ${showDetails ? 'blur-sm scale-95 opacity-40 pointer-events-none' : ''}`}>
            <div className="modal-head py-4 px-6 border-b border-line bg-ink flex justify-between items-center text-white">
              <h3 className="font-black uppercase italic tracking-tighter text-xs flex items-center gap-2">
                <Contact className="w-5 h-5 text-brand-gold" /> ESTADO DE CUENTA MAESTRO: {showClientHistory}
              </h3>
              <button onClick={() => setShowClientHistory(null)} className="text-white hover:text-brand-gold"><X className="w-5 h-5"/></button>
            </div>
            <div className="modal-body p-0 max-h-[70vh] overflow-y-auto bg-white">
               <div className="table-wrap">
                  <table className="w-full">
                    <thead className="bg-surface-soft sticky top-0 z-10">
                      <tr>
                        <th className="text-[9px] font-black uppercase p-4 text-left">Fecha</th>
                        <th className="text-[9px] font-black uppercase p-4 text-left">ID Documento</th>
                        <th className="text-[9px] font-black uppercase p-4 text-right">Monto Total</th>
                        <th className="text-[9px] font-black uppercase p-4 text-right">Abonado</th>
                        <th className="text-[9px] font-black uppercase p-4 text-right">Saldo Pend.</th>
                        <th className="text-[9px] font-black uppercase p-4 text-center">Estado</th>
                        <th className="text-[9px] font-black uppercase p-4 text-center">Auditoría</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.cxc.filter(d => d.cliente === showClientHistory).sort((a,b) => b.fecha.localeCompare(a.fecha)).map(d => (
                        <tr key={d.id} className="border-b border-line/30 hover:bg-surface-warm/20 transition-colors">
                          <td className="p-4 text-xs font-black">{Utils.fmtFecha(d.fecha)}</td>
                          <td className="p-4 text-xs font-black mono">{d.id}</td>
                          <td className="p-4 text-right text-xs font-black">{Utils.fmtUSD(d.montoUSD)}</td>
                          <td className="p-4 text-right text-xs font-black text-status-success">{Utils.fmtUSD(d.abonadoUSD)}</td>
                          <td className="p-4 text-right text-sm font-black text-brand-gold-deep">{Utils.fmtUSD(d.saldoUSD)}</td>
                          <td className="p-4 text-center">
                            <span className={`badge ${d.estado === 'pagada' ? 'badge-ok' : (d.estado === 'parcial' ? 'badge-info' : 'badge-warn')} font-black text-[8px] uppercase px-3`}>
                              {d.estado}
                            </span>
                          </td>
                          <td className="p-4 text-center">
                             <button onClick={() => setShowDetails(d)} className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-status-success border-2 border-status-success/20 hover:bg-status-success hover:text-white transition-all shadow-md"><Eye className="w-5 h-5"/></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
               </div>
            </div>
            <div className="modal-foot p-4 bg-surface-soft border-t border-line text-right">
               <button onClick={() => setShowClientHistory(null)} className="btn btn-primary px-8 font-black uppercase text-[10px] rounded-lg shadow-md">Cerrar Historial</button>
            </div>
          </div>
        </div>
      )}

      {isCreditView && (
        <div className="modal show"><div className="modal-bg" onClick={() => setIsCreditView(false)}></div>
          <div className="modal-box max-w-[380px] bg-white border-2 border-line">
            <div className="modal-head py-3 px-4 border-b border-line bg-surface-soft flex justify-between"><h3 className="text-ink text-xs font-black uppercase tracking-widest flex items-center gap-2"><HandCoins className="w-4 h-4 text-brand-gold" /> CARGAR CRÉDITO</h3><button onClick={() => setIsCreditView(false)}><X size={18} /></button></div>
            <div className="modal-body p-4 space-y-4">
              {!showNewClientForm ? (
                <div className="space-y-3">
                   <div className="bg-ink p-3 rounded-lg text-center mb-2"><p className="text-white/40 text-[8px] font-black uppercase mb-1">Monto a Deber</p><p className="text-2xl font-black text-brand-gold">{Utils.fmtUSD(subtotalUSD)}</p></div>
                   <div className="relative"><Search className="absolute left-3 top-2.5 w-4 h-4 text-ink opacity-30" /><input className="form-input pl-10 h-10 text-xs font-bold" placeholder="Buscar cliente..." value={clientSearch} onChange={e => setClientSearch(e.target.value)} /></div>
                   <div className="max-h-[160px] overflow-y-auto border border-line rounded-xl bg-gray-50 shadow-inner">{(filteredClients || []).map(c => (<div key={c.id} onClick={() => setSelectedClient(c)} className={`p-3 border-b border-line/40 cursor-pointer hover:bg-brand-gold-soft transition-all ${selectedClient?.id === c.id ? 'bg-brand-gold-soft border-l-4 border-l-brand-gold' : ''}`}><div className="text-xs font-black text-ink uppercase">{c.name}</div><div className="text-[10px] text-ink/40 mono">{c.cedula}</div></div>))}{filteredClients.length === 0 && <div className="p-10 text-center text-[10px] font-black text-ink/20 uppercase">No hay resultados</div>}</div>
                   <div className="flex flex-col gap-2"><button className="btn bg-status-info-soft text-status-info border border-status-info/40 font-black uppercase text-[10px] h-10 flex items-center justify-center gap-2" onClick={() => setShowNewClientForm(true)}><UserPlus className="w-4 h-4" /> Registrar Nuevo</button><button className="btn btn-primary w-full h-12 font-black uppercase text-xs shadow-md" disabled={!selectedClient || isProcessing} onClick={ejecutarVentaACredito}>{isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2 inline" /> : null}Cargar a Cartera</button></div>
                </div>
              ) : (
                <div className="space-y-4 animate-in slide-in-from-right-2 duration-200">
                  <div className="space-y-2">
                    <div className="space-y-1"><label className="text-[9px] font-black uppercase text-ink">Nombre Completo</label><input className="form-input h-9 text-xs font-black uppercase" value={newClient.name} onChange={e => setNewClient({...newClient, name: e.target.value})} /></div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-black uppercase text-ink">Cédula / Identificación</label>
                      <div className="grid grid-cols-[80px_1fr] gap-1.5 items-center">
                        <select 
                          className="form-select h-9 text-[10px] font-black bg-surface-soft border-line w-full px-1"
                          value={newClient.tipoDoc}
                          onChange={e => setNewClient({ ...newClient, tipoDoc: e.target.value })}
                        >
                          {['V', 'E', 'J', 'G', 'P'].map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <div className="relative">
                          <Hash className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-ink opacity-30" />
                          <input 
                            className="form-input pl-8 h-9 text-xs font-black w-full" 
                            placeholder="EJ: 13313521"
                            value={newClient.cedula}
                            onChange={e => handleNewClientCedulaChange(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1"><label className="text-[9px] font-black uppercase text-ink">Teléfono (XXXX-XXXXXXX)</label><input className="form-input h-9 text-xs font-black uppercase" value={newClient.phone} onChange={e => setNewClient({...newClient, phone: e.target.value})} placeholder="04XX-XXXXXXX" /></div>
                    <div className="space-y-1"><label className="text-[9px] font-black uppercase text-ink">Dirección</label><input className="form-input h-9 text-xs font-black uppercase" value={newClient.address} onChange={e => setNewClient({...newClient, address: e.target.value})} /></div>
                  </div>
                  <button className="btn btn-primary w-full h-12 font-black uppercase text-xs shadow-md" disabled={isProcessing} onClick={ejecutarVentaACredito}>{isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2 inline" /> : null}Guardar y Cargar</button>
                  <button className="text-[10px] text-ink font-black uppercase text-center w-full" onClick={() => setShowNewClientForm(false)}>Volver a la lista</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}