// src/App.tsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Lobby from './pages/Lobby';
import GameBoard from './pages/GameBoard';
import Rules from './pages/Rules';
import { useTranslation } from 'react-i18next';

// Simple auth guard (checks token in localStorage)
const PrivateRoute: React.FC<{ children: JSX.Element }> = ({ children }) => {
  const token = localStorage.getItem('token');
  return token ? children : <Navigate to="/login" replace />;
};

const App: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/dashboard"
          element={
            <PrivateRoute>
              <Dashboard />
            </PrivateRoute>
          }
        />
        <Route
          path="/lobby/:lobbyId?"
          element={
            <PrivateRoute>
              <Lobby />
            </PrivateRoute>
          }
        />
        <Route
          path="/game/:gameId"
          element={
            <PrivateRoute>
              <GameBoard />
            </PrivateRoute>
          }
        />
        <Route
          path="/rules"
          element={
            <PrivateRoute>
              <Rules />
            </PrivateRoute>
          }
        />
        <Route path="*" element={<div>{t('notFound') || 'Page not found'}</div>} />
      </Routes>
    </Router>
  );
};

export default App;
