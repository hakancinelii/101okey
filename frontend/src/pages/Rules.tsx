// src/pages/Rules.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const Rules: React.FC = () => {
    const { } = useTranslation();
    const navigate = useNavigate();

    return (
        <div className="min-h-screen bg-okey-table flex flex-col items-center justify-center p-6 text-white font-sans">
            {/* Ambient Background Elements */}
            <div className="absolute top-20 left-20 w-96 h-96 bg-amber-500/10 rounded-full blur-[100px] animate-pulse"></div>
            <div className="absolute bottom-20 right-20 w-96 h-96 bg-blue-500/10 rounded-full blur-[100px] animate-pulse delay-700"></div>

            <div className="w-full max-w-3xl glass-hud rounded-[40px] p-10 border border-white/10 shadow-3xl z-10 flex flex-col items-center relative overflow-hidden backdrop-blur-2xl">
                {/* Header */}
                <div className="flex flex-col items-center mb-10 w-full">
                    <div className="flex items-center space-x-4 mb-2">
                        <span className="text-4xl">📜</span>
                        <h1 className="text-4xl font-black tracking-tight uppercase">Oyun Kılavuzu</h1>
                    </div>
                    <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-amber-500/50 to-transparent"></div>
                </div>

                {/* Content Sections */}
                <div className="w-full space-y-8 overflow-y-auto max-h-[60vh] pr-4 custom-scrollbar">

                    {/* Basic Rules */}
                    <section className="bg-white/5 p-6 rounded-3xl border border-white/5 space-y-4">
                        <div className="flex items-center space-x-3">
                            <span className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400">
                                <span className="text-xs font-black">01</span>
                            </span>
                            <h3 className="text-xl font-black uppercase tracking-wide text-green-400">Temel Kurallar</h3>
                        </div>
                        <ul className="space-y-2 text-sm font-medium opacity-80 list-disc ml-5">
                            <li>101 Okey'de temel amaç, elinizdeki taşları belirli bir düzende (perler) masaya açarak veya diğer oyuncuların açtığı işlere ekleyerek elinizi bitirmektir.</li>
                            <li>Masaya ilk elinizi açabilmek için perlerinizin toplam sayı değerinin en az <b>101</b> olması gerekir.</li>
                        </ul>
                    </section>

                    {/* Sorting Rules */}
                    <section className="bg-white/5 p-6 rounded-3xl border border-white/5 space-y-4">
                        <div className="flex items-center space-x-3">
                            <span className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                                <span className="text-xs font-black">02</span>
                            </span>
                            <h3 className="text-xl font-black uppercase tracking-wide text-blue-400">Dizme ve Düzenleme</h3>
                        </div>
                        <ul className="space-y-4 text-sm font-medium opacity-80">
                            <li className="flex gap-4">
                                <div className="bg-blue-500/10 px-3 py-1 rounded-xl h-fit border border-blue-500/20 text-blue-400 font-bold whitespace-nowrap">SERİ DİZ</div>
                                <p>Taşları otomatik olarak seri perler (aynı renk ardışık: 7-8-9) ve grup perler (farklı renk aynı sayı: 10-10-10) şeklinde gruplar. Perler arasına boşluk bırakır ve sığmayanları alt kata taşır.</p>
                            </li>
                            <li className="flex gap-4">
                                <div className="bg-green-500/10 px-3 py-1 rounded-xl h-fit border border-green-500/20 text-green-400 font-bold whitespace-nowrap">ÇİFT DİZ</div>
                                <p>Taşları aynı renk ve aynı sayıdan oluşan çiftler halinde yan yana getirir. Aralara boşluk bırakarak organize eder.</p>
                            </li>
                        </ul>
                    </section>

                    {/* Scoring and Deck Rules */}
                    <section className="bg-white/5 p-6 rounded-3xl border border-white/5 space-y-4">
                        <div className="flex items-center space-x-3">
                            <span className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-400">
                                <span className="text-xs font-black">03</span>
                            </span>
                            <h3 className="text-xl font-black uppercase tracking-wide text-red-400">Puanlama ve Oyun Bitişi</h3>
                        </div>
                        <div className="space-y-4">
                            <div className="bg-red-500/10 p-4 rounded-2xl border border-red-500/20">
                                <h4 className="font-black text-xs uppercase text-red-300 mb-2">Destenin Bitmesi Durumu</h4>
                                <p className="text-xs opacity-80 leading-relaxed">
                                    Deste (pool) tamamen tükendiğinde oyun sona erer ve herkesin elindeki taşlara göre <b>Ceza Puanı</b> hesaplanır.
                                </p>
                            </div>
                            <ul className="space-y-3 text-sm font-medium opacity-80">
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 mt-1">✦</span>
                                    <span><b>Eğer el açmadıysanız:</b> Sabit <b>202 ceza puanı</b> alırsınız.</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 mt-1">✦</span>
                                    <span><b>Eğer el açtıysanız:</b> Elinizde kalan taşların sayı toplamı kadar ceza alırsınız.</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 mt-1">✦</span>
                                    <span><b>Elinizde Okey varsa:</b> Oyun bittiğinde eldeki Okey taşı tek başına <b>101 ceza puanı</b> yazdırır. Diğer taşlar normal toplanır.</span>
                                </li>
                            </ul>
                        </div>
                    </section>
                </div>

                {/* Footer Buttons */}
                <div className="mt-10 flex space-x-4 w-full justify-center">
                    <button
                        onClick={() => navigate('/dashboard')}
                        className="h-12 px-10 btn-premium btn-green text-sm font-black tracking-widest uppercase"
                    >
                        ANLADIM
                    </button>
                </div>
            </div>

            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.02);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.2);
                }
            `}</style>
        </div>
    );
};

export default Rules;
