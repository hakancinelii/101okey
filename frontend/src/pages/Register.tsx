// src/pages/Register.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BACKEND_URL } from '../config';

const Register: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Kayıt Başarısız');
            } else {
                localStorage.setItem('token', data.token);
                navigate('/dashboard');
            }
        } catch (e) {
            setError('Bağlantı Hatası');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-okey-table flex flex-col items-center justify-center p-6 text-white font-sans overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-64 bg-gradient-to-b from-black/40 to-transparent"></div>

            <div className="w-full max-w-md z-10 animate-in fade-in slide-in-from-bottom-12 duration-700">
                <div className="flex flex-col items-center mb-10">
                    <h1 className="text-5xl font-black tracking-tighter drop-shadow-2xl mb-2">
                        101 <span className="text-amber-500">OKEY</span>
                    </h1>
                    <div className="h-1 w-16 bg-amber-500/50 rounded-full"></div>
                </div>

                <div className="glass-hud rounded-[40px] p-10 border border-white/10 shadow-3xl relative overflow-hidden group">
                    <h2 className="text-2xl font-black uppercase tracking-tight text-center mb-8">{t('register')}</h2>

                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 text-red-500 px-4 py-3 rounded-2xl text-xs font-bold mb-6 text-center animate-shake">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest opacity-40 ml-4" htmlFor="name">{t('name')}</label>
                            <input
                                id="name"
                                type="text"
                                required
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-amber-500/50 transition-all placeholder:opacity-20"
                                placeholder="Ad Soyad"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest opacity-40 ml-4" htmlFor="email">{t('email')}</label>
                            <input
                                id="email"
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-amber-500/50 transition-all placeholder:opacity-20"
                                placeholder="example@email.com"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest opacity-40 ml-4" htmlFor="password">{t('password')}</label>
                            <input
                                id="password"
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-amber-500/50 transition-all placeholder:opacity-20"
                                placeholder="••••••••"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className={`w-full h-14 btn-premium btn-amber text-xs tracking-widest mt-4 text-black ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            {loading ? 'YÖNLENDİRİLİYOR...' : t('register').toUpperCase()}
                        </button>
                    </form>

                    <div className="mt-8 flex flex-col items-center">
                        <button
                            onClick={() => navigate('/login')}
                            className="text-xs font-black opacity-40 hover:opacity-100 transition-opacity uppercase tracking-widest"
                        >
                            HESABIN VAR MI? <span className="text-amber-500">GİRİŞ YAP</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Register;
