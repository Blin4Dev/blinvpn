import { createContext, useContext } from 'react';

// кто вошёл (GET /panel/auth/me)
export type Me = {
  kind: 'owner' | 'staff'; role: 'owner' | 'curator' | 'operator'; username: string; name: string; staff_id?: number;
  shift?: { working_today: boolean; on_shift: boolean; intervals: string[][] };
};

export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

export const isOwner = (me: Me | null) => me?.role === 'owner';
// owner + curator: полный доступ к поддержке и пользователям
export const isFull = (me: Me | null) => me?.role === 'owner' || me?.role === 'curator';

// какие страницы видит сотрудник; owner видит всё кроме «зарплаты»
export const canOpenPage = (me: Me | null, page: string): boolean => {
  if (!me) return false;
  if (me.role === 'owner') return page !== 'Зарплата';
  if (page === 'Поддержка' || page === 'Пользователи' || page === 'Зарплата') return true;
  if (page === 'Сотрудники') return me.role === 'curator';
  return false;
};
