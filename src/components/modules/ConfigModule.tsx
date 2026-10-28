'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AppState } from '@/lib/types';
import { Save, AlertTriangle, RefreshCw, Activity, BookOpen, PenLine, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { db } from '@/lib/turso/data-client';
import { doc, setDoc } from '@/lib/turso/data-client';
import { crearRespaldo, descargarRespaldo, cargarRespaldoDesdeArchivo } from '@/lib/backup';

export default function ConfigModule({ state, updateState }: { state: AppState, updateState: (s: Partial<AppState>) => void }) {
  const [tasa, setTasa] = useState<string | number>(state.tasa);
  const [empresa, setEmpresa] = useState(state.empresa);
  const [pinDevolucion, setPinDevolucion] = useState(state.pinDevolucion || '');
  const [isFormatting, setIsFormatting] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTasa(state.tasa);
    setEmpresa(state.empresa);
    setPinDevolucion(state.pinDevolucion || '000000');
  }, [state.tasa, state.empresa, state.pinDevolucion]);

  const guardarTasa = () => {
    const n = parseFloat(tasa.toString());
    if (isNaN(n)) return alert('Tasa inválida');
    updateState({ tasa: n });
    toast({ title: "Sincronizado", description: "Tasa de cambio actualizada en todos los terminales." });
  };

  const guardarEmpresa = () => {
    updateState({ empresa });
    toast({ title: "Perfil Actualizado", description: "Los datos fiscales han sido guardados." });
  };

  const guardarPin = () => {
    if (pinDevolucion.length !== 6) return alert('El PIN debe ser de 6 dígitos exactos');
    updateState({ pinDevolucion });
    toast({ title: "Seguridad Actualizada", description: "PIN de autorización establecido correctamente." });
  };

  const handleCrearRespaldo = async () => {
    setIsBackingUp(true);
    setBackupError(null);
    try {
      const backup = await crearRespaldo();
      descargarRespaldo(backup);
      toast({ title: "Respaldo Creado", description: "El archivo .json con todos los datos se descargó correctamente." });
    } catch (e: any) {
      console.error(e);
      setBackupError(e?.message || 'No fue posible crear el respaldo.');
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleArchivoRespaldo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBackupError(null);
    const confirmar = window.confirm('Se restaurará el sistema completo desde este respaldo. Los datos actuales serán reemplazados. ¿Desea continuar?');
    if (!confirmar) return;
    try {
      await cargarRespaldoDesdeArchivo(file);
      toast({ title: "Respaldo Restaurado", description: "El sistema fue restaurado correctamente. Se recomienda recargar la aplicación." });
    } catch (err: any) {
      console.error(err);
      setBackupError(err?.message || 'No se pudo cargar el respaldo seleccionado.');
    }
  };

  const formatearSistema = async () => {
    const confirmMsg =
      '⚠️ ¿ESTÁ ABSOLUTAMENTE SEGURO?\\n\\n' +
      'Se eliminarán los datos operativos de Turso, se revocarán las sesiones y se restablecerá la configuración.\\n' +
      'El administrador semilla se conservará con usuario admin y contraseña inicial admin123.\\n\\n' +
      'Esta acción no se puede deshacer.';
    if (!confirm(confirmMsg)) return;

    setIsFormatting(true);
    try {
      const response = await fetch('/api/admin/factory-reset', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasa: state.tasa })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'No se pudo reiniciar el sistema.');
      if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('posven_pro_session_data_cache');
        localStorage.removeItem('posven_pro_offline_operations_v1');
        localStorage.removeItem('posven_apertura_done');
        localStorage.removeItem('posven_last_cxp_alert');
      }
      toast({ title: 'Sistema reiniciado', description: 'Turso quedó limpio y el administrador semilla fue conservado.' });
      window.location.href = '/login';
    } catch (error: any) {
      console.error('Error en reinicio de fábrica Turso:', error);
      toast({ variant: 'destructive', title: 'Fallo en reinicio', description: error?.message || 'No se pudo completar el reinicio.' });
    } finally {
      setIsFormatting(false);
    }
  };  return (
    <div className="max-w-2xl space-y-6 animate-in fade-in duration-300 pb-20">
      {/* ===== TASA DE CAMBIO ===== */}      <div className="card shadow-lg border-line">
        <div className="card-head bg-surface-soft border-b border-line px-5 py-4">
          <h3 className="text-ink font-black uppercase text-xs tracking-widest">Tasa de Cambio Oficial</h3>
        </div>
        <div className="card-body p-6 space-y-4 bg-white">
          <div className="form-group">
            <label className="text-ink text-[10px] font-black uppercase block mb-2 opacity-70">VALOR DE REFERENCIA: 1 USD =</label>
            <div className="flex items-center gap-4">
              <input 
                type="number" 
                step="0.01"
                className="form-input flex-1 h-12 text-xl font-black text-brand-gold-deep border-line bg-surface-soft/30 px-4" 
                value={tasa} 
                onChange={e => setTasa(e.target.value)} 
              />
              <span className="text-ink font-black text-sm uppercase tracking-tighter">Bolívares (BS)</span>
            </div>
          </div>
          <button className="btn btn-primary h-12 px-8 font-black uppercase text-xs shadow-md mt-2" onClick={guardarTasa}>
            <Save className="w-4 h-4" /> Guardar Tasa Actualizada
          </button>
        </div>
      </div>

      {/* ===== SEGURIDAD ===== */}
      <div className="card shadow-lg border-line">
        <div className="card-head bg-surface-soft border-b border-line px-5 py-4">
          <h3 className="text-ink font-black uppercase text-xs tracking-widest">Seguridad de Operaciones</h3>
        </div>
        <div className="card-body p-6 bg-white">
          <div className="form-group">
            <label className="text-ink text-[10px] font-black uppercase block mb-2 opacity-70">PIN de Autorización (6 Dígitos)</label>
            <input 
              type="password" 
              maxLength={6}
              className="form-input h-14 text-2xl font-black text-brand-gold-deep border-line bg-surface-soft/30 text-center tracking-[0.5em]" 
              value={pinDevolucion} 
              onChange={e => setPinDevolucion(e.target.value.replace(/\D/g, ''))} 
            />
          </div>
          <button className="btn btn-primary h-12 px-8 font-black uppercase text-xs shadow-md mt-4" onClick={guardarPin}>
            <Save className="w-4 h-4" /> Establecer PIN
          </button>
        </div>
      </div>

      {/* ===== DATOS FISCALES ===== */}
      <div className="card shadow-lg border-line">
        <div className="card-head bg-surface-soft border-b border-line px-5 py-4">
          <h3 className="text-ink font-black uppercase text-xs tracking-widest">Datos de Identidad Fiscal</h3>
        </div>
        <div className="card-body p-6 space-y-5 bg-white">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="form-group">
              <label className="text-ink text-[10px] font-black uppercase block mb-1.5 opacity-70">Nombre del Negocio</label>
              <input className="form-input h-10 font-bold border-line" value={empresa.nombre} onChange={e => setEmpresa({...empresa, nombre: e.target.value})} />
            </div>
            <div className="form-group">
              <label className="text-ink text-[10px] font-black uppercase block mb-1.5 opacity-70">Número de RIF</label>
              <input className="form-input h-10 font-black border-line uppercase" value={empresa.rif} onChange={e => setEmpresa({...empresa, rif: e.target.value})} />
            </div>
            <div className="form-group">
              <label className="text-ink text-[10px] font-black uppercase block mb-1.5 opacity-70">Teléfono de Contacto</label>
              <input className="form-input h-10 font-bold border-line" value={empresa.telefono} onChange={e => setEmpresa({...empresa, telefono: e.target.value})} />
            </div>
            <div className="form-group">
              <label className="text-ink text-[10px] font-black uppercase block mb-1.5 opacity-70">Dirección Fiscal</label>
              <input className="form-input h-10 font-bold border-line uppercase" value={empresa.direccion} onChange={e => setEmpresa({...empresa, direccion: e.target.value})} />
            </div>
          </div>
          <button className="btn btn-primary h-12 px-8 font-black uppercase text-xs shadow-md" onClick={guardarEmpresa}>
            <Save className="w-4 h-4" /> Actualizar Empresa
          </button>
        </div>
      </div>

      {/* ===== RESPALDO DE DATOS ===== */}
      <div className="card shadow-lg border-line">
        <div className="card-head bg-surface-soft border-b border-line px-5 py-4">
          <h3 className="text-ink font-black uppercase text-xs tracking-widest flex items-center gap-2">
            <Database className="w-4 h-4" /> Respaldo de Datos
          </h3>
        </div>
        <div className="card-body p-6 space-y-4 bg-white">
          <p className="text-xs text-ink font-bold">
            Cree un respaldo completo del sistema (inventario, ventas, cuentas por cobrar/pagar, clientes, proveedores, usuarios, terminales, catálogos y configuración) como archivo <code className="font-mono">.json</code>. Puede restaurarlo posteriormente en este mismo equipo o en otro.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              className="btn btn-primary h-12 px-8 font-black uppercase text-xs shadow-md flex items-center gap-2"
              onClick={handleCrearRespaldo}
              disabled={isBackingUp}
            >
              {isBackingUp ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {isBackingUp ? 'PREPARANDO RESPALDO...' : 'Crear Respaldo'}
            </button>

            <button
              className="btn h-12 px-8 font-black uppercase text-xs shadow-md flex items-center gap-2 border border-line bg-surface-soft/50 hover:bg-surface-soft"
              onClick={() => fileInputRef.current?.click()}
            >
              <Database className="w-4 h-4" />
              Cargar Respaldo
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleArchivoRespaldo}
          />

          {backupError && (
            <div className="p-4 rounded-lg border bg-red-50 border-red-500">
              <p className="text-xs text-red-700 font-black uppercase">Error al cargar el respaldo</p>
              <p className="text-xs text-red-700 mt-1">{backupError}</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== ZONA DE SEGURIDAD CRÍTICA ===== */}
      <div className="card border-status-danger/30 bg-status-danger-soft">
        <div className="card-head border-b border-status-danger/20 px-5 py-4">
          <h3 className="text-status-danger font-black uppercase italic text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Zona de Seguridad Crítica
          </h3>
        </div>
        <div className="card-body p-6">
          <p className="text-xs text-ink font-bold mb-5 uppercase">
            ESTA ACCIÓN ELIMINARÁ TODOS LOS DATOS DEL SISTEMA DE MANERA PERMANENTE.
          </p>
          <button 
            className="btn btn-danger h-12 px-8 font-black uppercase text-xs shadow-xl flex items-center gap-2" 
            onClick={formatearSistema}
            disabled={isFormatting}
          >
            {isFormatting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
            {isFormatting ? 'FORMATEANDO...' : 'Limpiar Todo el Sistema'}
          </button>
        </div>
      </div>
    </div>
  );
}