import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const STACK_KEY = "blinvpn_route_stack";

export function trackRoute(pathWithSearch: string, replace = false): void {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    const stack = raw ? (JSON.parse(raw) as string[]) : [];
    const safeStack = Array.isArray(stack) ? stack : [];
    // navigate(..., { replace: true }) заменяет текущую запись, а не добавляет новую:
    // иначе «Назад» вернёт на заменённый адрес (например, /subscription?setup=1).
    if (replace && safeStack.length) {
      const next = [...safeStack.slice(0, -1), pathWithSearch];
      const deduped = next.filter((v, i) => i === 0 || v !== next[i - 1]);
      sessionStorage.setItem(STACK_KEY, JSON.stringify(deduped));
      return;
    }
    const currentIndex = safeStack.lastIndexOf(pathWithSearch);

    // Если пользователь вернулся через POP, выравниваем стек под текущий маршрут.
    if (currentIndex >= 0 && currentIndex < safeStack.length - 1) {
      const trimmed = safeStack.slice(0, currentIndex + 1);
      sessionStorage.setItem(STACK_KEY, JSON.stringify(trimmed));
      return;
    }

    if (safeStack[safeStack.length - 1] !== pathWithSearch) {
      const next = [...safeStack, pathWithSearch].slice(-50);
      sessionStorage.setItem(STACK_KEY, JSON.stringify(next));
    }
  } catch {
    // Игнорируем ошибки хранилища, чтобы не ломать навигацию.
  }
}

function getPreviousRoute(current: string): string | null {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    const stack = raw ? (JSON.parse(raw) as string[]) : [];
    if (!Array.isArray(stack) || stack.length < 2) {
      return null;
    }
    const idx = stack.lastIndexOf(current);
    const from = idx <= 0 ? stack.length - 1 : idx;
    // Пропускаем ту же страницу с другими параметрами (например, /subscription?setup=1
    // перед /subscription) — «Назад» должен уводить на предыдущую страницу.
    const pathOf = (v: string) => v.split("?")[0];
    for (let i = from - 1; i >= 0; i--) {
      if (pathOf(stack[i]) !== pathOf(current)) return stack[i];
    }
    return null;
  } catch {
    return null;
  }
}

export function useSmartBack(fallbackPath = "/") {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    const current = `${location.pathname}${location.search}`;

    const previousInApp = getPreviousRoute(current);
    if (previousInApp && previousInApp !== current) {
      navigate(previousInApp);
      return;
    }

    navigate(fallbackPath, { replace: true });
  }, [location.pathname, location.search, navigate, fallbackPath]);
}
