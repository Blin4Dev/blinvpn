import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const STACK_KEY = "blinvpn_route_stack";

export function trackRoute(pathWithSearch: string): void {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    const stack = raw ? (JSON.parse(raw) as string[]) : [];
    const safeStack = Array.isArray(stack) ? stack : [];
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
    if (idx <= 0) {
      return stack[stack.length - 2] || null;
    }
    return stack[idx - 1] || null;
  } catch {
    return null;
  }
}

export function useSmartBack(fallbackPath = "/") {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    const current = `${location.pathname}${location.search}`;

    // Спец-правило для онбординга: кнопка "Назад" возвращает на предыдущий шаг.
    if (location.pathname === "/subscription/start") {
      const params = new URLSearchParams(location.search);
      const step = Number(params.get("step") || "1");
      if (Number.isFinite(step) && step > 1) {
        params.set("step", String(step - 1));
        navigate(`/subscription/start?${params.toString()}`);
        return;
      }
      navigate("/", { replace: true });
      return;
    }

    const previousInApp = getPreviousRoute(current);
    if (previousInApp && previousInApp !== current) {
      navigate(previousInApp);
      return;
    }

    navigate(fallbackPath, { replace: true });
  }, [location.pathname, location.search, navigate, fallbackPath]);
}
