import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/AuthContext.jsx';
import { fetchJson } from '../api/client.js';

export default function AdminDashboard({ onClose }) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('directory'); // 'directory' or 'audit'
  
  // Directory state
  const [investigators, setInvestigators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', role: 'INVESTIGATOR', department: 'General' });

  // Audit state
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'directory') {
      fetchInvestigators();
    } else if (activeTab === 'audit') {
      fetchAuditLogs();
    }
  }, [activeTab]);

  const fetchInvestigators = async () => {
    try {
      setLoading(true);
      const data = await fetchJson('/api/investigators');
      setInvestigators(data.investigators);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      setAuditLoading(true);
      const data = await fetchJson('/api/audit');
      setAuditLogs(data.logs || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleToggleActive = async (id, currentStatus) => {
    try {
      await fetchJson('/api/investigators/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentStatus })
      });
      setInvestigators(prev => prev.map(inv => inv.id === id ? { ...inv, isActive: !currentStatus } : inv));
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to permanently delete this investigator? This cannot be undone.')) return;
    try {
      await fetchJson('/api/investigators/' + id, { method: 'DELETE' });
      setInvestigators(prev => prev.filter(inv => inv.id !== id));
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    try {
      await fetchJson('/api/investigators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      alert('Investigator created successfully! (Email integration coming in next step to send activation token)');
      setShowAddModal(false);
      setFormData({ name: '', email: '', role: 'INVESTIGATOR', department: 'General' });
      fetchInvestigators();
    } catch (err) {
      alert(err.message);
    }
  };

  if (user?.role !== 'SUPERVISOR') {
    return (
      <div className="absolute inset-0 bg-slate-950/90 z-50 flex items-center justify-center backdrop-blur-sm p-4">
        <div className="dark-panel p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-bold text-red-500 mb-2">Access Denied</h2>
          <p className="text-slate-400 mb-6">You must be a SUPERVISOR to view this page.</p>
          <button onClick={onClose} className="btn-primary w-full">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-slate-950/95 z-50 flex flex-col backdrop-blur-md animate-fade-in">
      <div className="flex items-center justify-between p-6 border-b border-white/10">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-wide">Administration</h1>
          <p className="text-sm text-slate-400 mt-1">Manage users and audit system usage</p>
        </div>
        <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors">
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="flex border-b border-white/10 px-6">
        <button 
          onClick={() => setActiveTab('directory')}
          className={'py-3 px-4 text-sm font-bold tracking-wide uppercase transition-colors border-b-2 ' + (activeTab === 'directory' ? 'border-purple-500 text-purple-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
        >
          Active Directory
        </button>
        <button 
          onClick={() => setActiveTab('audit')}
          className={'py-3 px-4 text-sm font-bold tracking-wide uppercase transition-colors border-b-2 ' + (activeTab === 'audit' ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
        >
          Audit Logs
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {error && (
            <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {activeTab === 'directory' && (
            <>
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-slate-200">Active Directory</h2>
                <button 
                  onClick={() => setShowAddModal(true)}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded shadow transition-colors text-sm font-bold tracking-wide flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                  Add Investigator
                </button>
              </div>

              <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-800/50 border-b border-white/10 text-xs uppercase tracking-widest text-slate-400">
                      <th className="p-4 font-medium">Name</th>
                      <th className="p-4 font-medium">Email</th>
                      <th className="p-4 font-medium">Role</th>
                      <th className="p-4 font-medium">Department</th>
                      <th className="p-4 font-medium text-center">Status</th>
                      <th className="p-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm divide-y divide-white/5">
                    {loading ? (
                      <tr><td colSpan="6" className="p-8 text-center text-slate-500">Loading directory...</td></tr>
                    ) : investigators.length === 0 ? (
                      <tr><td colSpan="6" className="p-8 text-center text-slate-500">No users found.</td></tr>
                    ) : (
                      investigators.map(inv => (
                        <tr key={inv.id} className="hover:bg-white/5 transition-colors">
                          <td className="p-4 font-medium text-slate-200">{inv.name}</td>
                          <td className="p-4 text-slate-400">{inv.email}</td>
                          <td className="p-4">
                            <span className={'px-2 py-1 rounded text-[10px] font-bold tracking-wider ' + (inv.role === 'SUPERVISOR' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : inv.role === 'ANALYST' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-purple-500/20 text-purple-400 border border-purple-500/30')}>
                              {inv.role}
                            </span>
                          </td>
                          <td className="p-4 text-slate-400">{inv.department}</td>
                          <td className="p-4 text-center">
                            {inv.isActive ? (
                              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-green-500/10 text-green-400 text-[10px] font-bold tracking-widest rounded border border-green-500/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_5px_#4ade80]"></span>
                                ACTIVE
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-red-500/10 text-red-400 text-[10px] font-bold tracking-widest rounded border border-red-500/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                                REVOKED
                              </span>
                            )}
                          </td>
                          <td className="p-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button onClick={() => handleToggleActive(inv.id, inv.isActive)} disabled={inv.id === user.id} className={'text-xs px-3 py-1.5 rounded border transition-colors ' + (inv.id === user.id ? 'opacity-30 cursor-not-allowed border-slate-600 text-slate-500' : inv.isActive ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-green-500/30 text-green-400 hover:bg-green-500/10')}>
                                {inv.isActive ? 'Deactivate' : 'Reactivate'}
                              </button>
                              <button onClick={() => handleDelete(inv.id)} disabled={inv.id === user.id} className={'text-xs px-3 py-1.5 rounded border transition-colors ' + (inv.id === user.id ? 'opacity-30 cursor-not-allowed border-slate-600 text-slate-500' : 'border-red-600/50 text-red-500 hover:bg-red-600/10')}>
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === 'audit' && (
            <>
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-slate-200">System Audit Logs</h2>
                <div className="text-xs text-slate-400">Showing latest 100 actions</div>
              </div>

              <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-800/50 border-b border-white/10 text-xs uppercase tracking-widest text-slate-400">
                      <th className="p-4 font-medium w-48">Timestamp</th>
                      <th className="p-4 font-medium w-48">Investigator</th>
                      <th className="p-4 font-medium w-40">Action</th>
                      <th className="p-4 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm divide-y divide-white/5">
                    {auditLoading ? (
                      <tr><td colSpan="4" className="p-8 text-center text-slate-500">Loading audit trail...</td></tr>
                    ) : auditLogs.length === 0 ? (
                      <tr><td colSpan="4" className="p-8 text-center text-slate-500">No actions recorded.</td></tr>
                    ) : (
                      auditLogs.map((log, i) => (
                        <tr key={i} className="hover:bg-white/5 transition-colors">
                          <td className="p-4 text-xs font-mono text-slate-400">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="p-4">
                            <div className="font-medium text-slate-200">{log.investigatorName}</div>
                            <div className="text-[10px] font-mono text-slate-500 truncate" title={log.investigatorId}>{log.investigatorId.substring(0, 8)}...</div>
                          </td>
                          <td className="p-4">
                            <span className="px-2 py-1 bg-white/5 text-slate-300 text-[10px] font-bold tracking-wider rounded border border-white/10">
                              {log.action}
                            </span>
                          </td>
                          <td className="p-4">
                            <pre className="text-[10px] font-mono text-slate-400 whitespace-pre-wrap">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

        </div>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="dark-panel max-w-md w-full border border-white/10 shadow-2xl animate-scale-up">
            <div className="p-6 border-b border-white/10 flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Add Investigator</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">?</button>
            </div>
            <form onSubmit={handleAddSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Full Name</label>
                <input type="text" required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-purple-500 transition-colors" placeholder="e.g. Rahul Kumar" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Email Address</label>
                <input type="email" required value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-purple-500 transition-colors" placeholder="e.g. rahul@cybercell.gov.in" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Role</label>
                <select value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-purple-500 transition-colors">
                  <option value="ANALYST">ANALYST (Read-only)</option>
                  <option value="INVESTIGATOR">INVESTIGATOR (Standard)</option>
                  <option value="SUPERVISOR">SUPERVISOR (Admin)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">Department / Unit</label>
                <input type="text" value={formData.department} onChange={e => setFormData({...formData, department: e.target.value})} className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white focus:outline-none focus:border-purple-500 transition-colors" placeholder="e.g. Cyber Crime Unit" />
              </div>
              <div className="bg-purple-900/20 border border-purple-500/20 p-3 rounded text-xs text-purple-300 leading-relaxed mt-6">
                <strong>Note:</strong> You will not set a password here. The system will generate an activation token. (Email delivery is coming in Step 2).
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/10">
                <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
                <button type="submit" className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-bold rounded shadow transition-colors">Create Account</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
