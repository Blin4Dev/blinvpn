import { useState, useEffect } from 'react';
import { apiFetch } from './api';

export const PAGE_SIZE = 100;

export function parseListResponse(res: any): { items: any[]; total: number | null } {
  if (Array.isArray(res)) return { items: res, total: null };
  if (res && typeof res === 'object') {
    const items =
      (Array.isArray(res.items) && res.items) ||
      (Array.isArray(res.data) && res.data) ||
      (Array.isArray(res.results) && res.results) ||
      (Array.isArray(res.rows) && res.rows) || [];
    const totalRaw = res.total ?? res.count ?? res.total_count ?? res.totalCount ?? null;
    const total = totalRaw == null ? null : Number(totalRaw);
    return { items, total: Number.isFinite(total as number) ? total : null };
  }
  return { items: [], total: null };
}

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export interface UsePaginatedListOptions {
  basePath: string;
  search: string;
  extraParams?: Record<string, string | undefined>;
  mapItem: (raw: any) => any;
  clientFilter?: (item: any) => boolean;
  enabled?: boolean;
  reloadKey?: number;
}

export function usePaginatedList(opts: UsePaginatedListOptions) {
  const { basePath, search, extraParams, mapItem, clientFilter, enabled = true, reloadKey = 0 } = opts;
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [page, setPageState] = useState(1);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localReload, setLocalReload] = useState(0);
  const extraKey = JSON.stringify(extraParams || {});

  useEffect(() => { setPageState(1); }, [debouncedSearch, extraKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const offset = (page - 1) * PAGE_SIZE;
        const qp = new URLSearchParams();
        qp.set('limit', String(PAGE_SIZE));
        qp.set('offset', String(offset));
        qp.set('page', String(page));
        if (debouncedSearch) { qp.set('search', debouncedSearch); qp.set('q', debouncedSearch); }
        if (extraParams) {
          for (const [k, v] of Object.entries(extraParams)) {
            if (v != null && v !== '' && v !== 'all') qp.set(k, v);
          }
        }
        const res = await apiFetch(`${basePath}?${qp.toString()}`);
        if (cancelled) return;
        const { items: rawItems, total: serverTotal } = parseListResponse(res);
        const backendIgnoresPaging = rawItems.length > PAGE_SIZE;

        if (backendIgnoresPaging) {
          let all = rawItems.map(mapItem);
          if (debouncedSearch) {
            const q = debouncedSearch.toLowerCase();
            all = all.filter((it: any) => searchableMatch(it, q));
          }
          if (clientFilter) all = all.filter(clientFilter);
          const start = (page - 1) * PAGE_SIZE;
          setItems(all.slice(start, start + PAGE_SIZE));
          setTotal(all.length);
        } else {
          let pageItems = rawItems.map(mapItem);
          if (clientFilter) pageItems = pageItems.filter(clientFilter);
          let totalCount: number;
          if (serverTotal != null) totalCount = serverTotal;
          else if (pageItems.length < PAGE_SIZE) totalCount = offset + pageItems.length;
          else totalCount = offset + pageItems.length + 1;
          setItems(pageItems);
          setTotal(totalCount);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Не удалось загрузить данные');
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, page, debouncedSearch, extraKey, enabled, reloadKey, localReload]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const setPage = (p: number) => setPageState(Math.min(Math.max(1, p), Math.max(1, totalPages)));

  return {
    items, total, page, totalPages, loading, error, setPage,
    nextPage: () => setPage(page + 1),
    prevPage: () => setPage(page - 1),
    reload: () => setLocalReload((n) => n + 1),
  };
}

export function searchableMatch(item: any, q: string): boolean {
  const fields = [item.username, item.name, item.user, item.key, item.refCode,
    item.telegramId != null ? String(item.telegramId) : '', item.id != null ? String(item.id) : ''];
  return fields.filter((f) => f != null && f !== '').map((f) => String(f).toLowerCase()).join(' ').includes(q);
}
