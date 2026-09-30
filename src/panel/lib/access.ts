import { createContext, useContext } from 'react';

/** Кто вошёл: владелец панели, куратор или оператор поддержки (GET /panel/auth/me). */
export type Me = {
  kind: 'owner' | 'staff'; role: 'owner' | 'curator' | 'operator'; username: string; name: string; staff_id?: number;
  shift?: { working_today: boolean; on_shift: boolean; intervals: string[][] };
};

export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

export const isOwner = (me: Me | null) => me?.role === 'owner';
/** Полный доступ к поддержке и пользователям: владелец и кураторы. */
export const isFull = (me: Me | null) => me?.role === 'owner' || me?.role === 'curator';

/** Какие страницы видит сотрудник. Владелец — все, кроме «Зарплаты» (она для сотрудников). */
export const canOpenPage = (me: Me | null, page: string): boolean => {
  if (!me) return false;
  if (me.role === 'owner') return page !== 'Зарплата';
  if (page === 'Поддержка' || page === 'Пользователи' || page === 'Зарплата') return true;
  if (page === 'Сотрудники') return me.role === 'curator';
  return false;
};
