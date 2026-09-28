import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState(null);

  // Check active session on mount
  useEffect(() => {
    auth.me()
      .then((data) => {
        const userData = data.investigator || data.user;
        if (data.ok && userData) {
          setUser(userData);
        }
      })
      .catch((err) => {
        // 401 just means not logged in, ignore. Other errors could be network down.
        if (err.status !== 401) {
          console.error("Auth check failed:", err);
        }
      })
      .finally(() => {
        setLoading(false);
        setInitialLoad(false);
      });
  }, []);

  const login = async (email, password) => {
    setLoading(true);
    setError(null);
    try {
      const data = await auth.login(email, password);
      
      // If it requires MFA, don't set user yet, return the payload
      if (data.requiresMfaSetup || data.requiresMfa) {
        return data;
      }
      
      const userData = data.investigator || data.user;
      if (data.ok && userData) {
        setUser(userData);
        return data;
      }
      
      throw new Error('Authentication succeeded but user payload was missing');
    } catch (err) {
      setError(err.message || 'Login failed');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const completeMfa = (userData) => {
    setUser(userData);
  };

  const logout = async () => {
    setLoading(true);
    try {
      await auth.logout();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setUser(null);
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, initialLoad, error, login, logout, completeMfa }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

