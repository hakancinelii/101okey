// src/pages/Dashboard.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// Removed unused PremiumToggle import

const Dashboard: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const handleLogout = () => {
        localStorage.removeItem('token');
        navigate('/login');
    };

    const token = localStorage.getItem('token');
    let userEmail = '';
    if (token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            userEmail = payload.email || payload.userId || 'Player';
        } catch (e) {
            userEmail = 'Player';
        }
    }

    return (
        <div className="min-h-screen bg-okey-table flex flex-col items-center justify-center p-6 text-white font-sans overflow-hidden">
            {/* Ambient Background Elements */}
            <div className="absolute top-20 left-20 w-96 h-96 bg-green-500/10 rounded-full blur-[100px] animate-pulse"></div>
            <div className="absolute bottom-20 right-20 w-96 h-96 bg-blue-500/10 rounded-full blur-[100px] animate-pulse delay-700"></div>

            <div className="w-full max-w-4xl flex flex-col items-center space-y-12 z-10 transition-all duration-700 animate-in fade-in slide-in-from-bottom-8">
                {/* Header Logo/Name */}
                <div className="flex flex-col items-center space-y-2">
                    <h1 className="text-6xl font-black tracking-tighter drop-shadow-2xl">
                        101 <span className="text-amber-500">OKEY</span> PLUS
                    </h1>
                    <div className="h-1 w-24 bg-gradient-to-r from-transparent via-amber-500 to-transparent rounded-full opacity-50"></div>
                </div>

                {/* User Profile Banner */}
                <div className="w-full max-w-lg glass-hud rounded-[40px] p-8 border border-white/10 shadow-3xl flex items-center justify-between relative overflow-hidden group">
                    {/* Inner Highlights */}
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>

                    <div className="flex items-center space-x-6">
                        <div className="relative">
                            <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-amber-500/30 group-hover:border-amber-500 transition-all duration-500 shadow-2xl">
                                <img src={`https://api.dicebear.com/7.x/pixel-art/svg?seed=${userEmail}`} alt="avatar" className="w-full h-full object-cover" />
                            </div>
                            <div className="absolute -bottom-1 -right-1 bg-amber-500 w-8 h-8 rounded-full border-4 border-black/20 flex items-center justify-center shadow-lg">
                                <span className="text-[10px] font-black">10</span>
                            </div>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xs font-black opacity-40 uppercase tracking-widest leading-none mb-1">PRO OYUNCU</span>
                            <h2 className="text-2xl font-black uppercase tracking-tight">{userEmail}</h2>
                            <div className="flex items-center mt-3 bg-black/40 px-3 py-1.5 rounded-full border border-white/5 shadow-inner">
                                <span className="text-amber-500 mr-2">💰</span>
                                <span className="font-bold text-sm tracking-tight text-amber-50">500.000 ÇİP</span>
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={handleLogout}
                        className="w-12 h-12 flex items-center justify-center bg-red-500/10 hover:bg-red-500/30 text-red-500 rounded-2xl transition-all border border-red-500/20 group"
                        title={t('logout')}
                    >
                        <span className="text-2xl group-hover:scale-110 transition-transform">🚪</span>
                    </button>
                </div>

                {/* Main Action Grid */}
                <div className="grid grid-cols-2 gap-6 w-full max-w-2xl px-4">
                    <button
                        onClick={() => navigate(`/lobby/${Math.random().toString(36).substring(2, 9)}`)}
                        className="group relative flex flex-col items-center justify-center h-48 bg-gradient-to-br from-green-500/80 to-green-700/80 rounded-[40px] border border-white/20 shadow-2xl transition-all duration-300 hover:scale-105 hover:-translate-y-2 active:scale-95 overflow-hidden"
                    >
                        <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-5xl mb-4 drop-shadow-lg group-hover:scale-110 transition-transform">🎴</span>
                        <span className="text-xl font-black uppercase tracking-widest">MASA KUR</span>
                        <span className="text-[10px] uppercase font-bold opacity-60 mt-2 tracking-tighter">YENİ OYUN BAŞLAT</span>
                    </button>

                    <button
                        onClick={() => navigate('/lobby/default')}
                        className="group relative flex flex-col items-center justify-center h-48 bg-gradient-to-br from-amber-500/80 to-amber-700/80 rounded-[40px] border border-white/20 shadow-2xl transition-all duration-300 hover:scale-105 hover:-translate-y-2 active:scale-95 overflow-hidden"
                    >
                        <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-5xl mb-4 drop-shadow-lg group-hover:scale-110 transition-transform">⚡</span>
                        <span className="text-xl font-black uppercase tracking-widest">HEMEN OYNA</span>
                        <span className="text-[10px] uppercase font-bold opacity-60 mt-2 tracking-tighter">GENEL MASAYA KATIL</span>
                    </button>
                </div>

                {/* Secondary Actions */}
                <div className="flex space-x-4">
                    <button
                        onClick={() => navigate('/rules')}
                        className="h-12 px-8 btn-premium btn-blue text-xs tracking-widest uppercase"
                    >
                        📚 NASIL OYNANIR?
                    </button>
                    <button className="h-12 px-8 btn-premium btn-green text-xs tracking-widest uppercase">
                        {t('gameStats')}
                    </button>
                    <button className="h-12 px-8 btn-premium btn-amber text-xs tracking-widest uppercase">
                        {t('buyAction')}
                    </button>
                </div>

                {/* Footer Stats Footer */}
                <div className="pt-8 flex items-center space-x-12 opacity-30">
                    <div className="flex flex-col items-center">
                        <span className="text-2xl font-black">1.4K</span>
                        <span className="text-[8px] font-black uppercase tracking-[0.2em]">Aktif Masa</span>
                    </div>
                    <div className="w-[1px] h-6 bg-white/20"></div>
                    <div className="flex flex-col items-center">
                        <span className="text-2xl font-black">12.8M</span>
                        <span className="text-[8px] font-black uppercase tracking-[0.2em]">Toplam Çip</span>
                    </div>
                    <div className="w-[1px] h-6 bg-white/20"></div>
                    <div className="flex flex-col items-center">
                        <span className="text-2xl font-black">8.2K</span>
                        <span className="text-[8px] font-black uppercase tracking-[0.2em]">Online</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Dashboard;
