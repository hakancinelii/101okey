// src/pages/Login.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const Login: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Giriş Başarısız');
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
            {/* Ambient Background Elements */}
            <div className="absolute top-0 inset-x-0 h-64 bg-gradient-to-b from-black/40 to-transparent"></div>
            <div className="absolute -top-24 -left-24 w-96 h-96 bg-amber-500/10 rounded-full blur-[120px] animate-pulse"></div>
            <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-green-500/10 rounded-full blur-[120px] animate-pulse delay-700"></div>

            <div className="w-full max-w-md z-10 animate-in fade-in slide-in-from-bottom-12 duration-700">
                <div className="flex flex-col items-center mb-10">
                    <h1 className="text-5xl font-black tracking-tighter drop-shadow-2xl mb-2">
                        101 <span className="text-amber-500">OKEY</span>
                    </h1>
                    <div className="h-1 w-16 bg-amber-500/50 rounded-full"></div>
                </div>

                <div className="glass-hud rounded-[40px] p-10 border border-white/10 shadow-3xl relative overflow-hidden group">
                    {/* Gloss effect */}
                    <div className="absolute -top-1/2 -left-1/2 w-[200%] h-[200%] bg-gradient-to-br from-white/5 to-transparent rotate-12 pointer-events-none transition-transform duration-1000 group-hover:translate-x-4"></div>

                    <h2 className="text-2xl font-black uppercase tracking-tight text-center mb-8">{t('login')}</h2>

                    {error && (
                        <div className="bg-red-500/10 border border-red-500/20 text-red-500 px-4 py-3 rounded-2xl text-xs font-bold mb-6 text-center animate-shake">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest opacity-40 ml-4" htmlFor="email">
                                {t('email')}
                            </label>
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
                            <label className="text-[10px] font-black uppercase tracking-widest opacity-40 ml-4" htmlFor="password">
                                {t('password')}
                            </label>
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
                            className={`w-full h-14 btn-premium btn-green text-xs tracking-widest mt-4 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            {loading ? 'YÜKLENİYOR...' : t('login').toUpperCase()}
                        </button>
                    </form>

                    <div className="mt-8 flex flex-col items-center space-y-4">
                        <button
                            onClick={() => navigate('/register')}
                            className="text-xs font-black opacity-40 hover:opacity-100 transition-opacity uppercase tracking-widest"
                        >
                            HESABIN YOK MU? <span className="text-amber-500">KAYIT OL</span>
                        </button>
                    </div>
                </div>

                <p className="mt-8 text-center text-[10px] font-black opacity-20 uppercase tracking-[0.3em]">
                    © 2024 OKEY PLUS PRO
                </p>
            </div>
        </div>
    );
};

export default Login;
