import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Btn, Card, CardLabel, LoadingScreen, PageHeader, Screen, T } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch } from "../utils/api";
import { formatDateRu } from "../utils/date";

type SubResponse = { key?: { expiry_date?: string | null; no_renew?: boolean | null } | null };

// продление: платная подписка идёт на общую страницу оплаты
export default function ExtendSubscription() {
  const navigate = useNavigate();
  const goBack = useSmartBack("/subscription");
  const [sub, setSub] = useState<SubResponse | null>(null);

  useEffect(() => {
    appFetch<SubResponse>("/subscription").then(setSub).catch(() => setSub({}));
  }, []);

  if (!sub) return <LoadingScreen />;
  if (!sub.key?.no_renew) return <Navigate to="/payment?extend=1" replace />;

  return (
    <Screen>
      <PageHeader title="Продлить" onBack={goBack} />
      <Card>
        <CardLabel>Продление</CardLabel>
        <div style={{ fontSize: 22, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
          Недоступно
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 8, lineHeight: 1.45 }}>
          Эту подписку нельзя продлить. Она работает до {sub.key?.expiry_date ? formatDateRu(sub.key.expiry_date) : "конца срока"}, после чего будет удалена — тогда можно будет оформить новую.
        </div>
      </Card>
      <div style={{ marginTop: "auto", paddingTop: 8 }}>
        <Btn variant="secondary" onClick={() => navigate("/subscription")}>К подписке</Btn>
      </div>
    </Screen>
  );
}
