// «Андрос» — вкладка окремого проєкту по Андросу. Заготовка: функціонал
// поетапно переноситься сюди з окремої програми (паралельні PR-и колеги).
import { Card, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

export default function Andros() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t("Андрос")} subtitle={t("Окремий проєкт — функціонал поетапно переноситься сюди")} />
      <Card>
        <Empty>{t("Сторінка-заготовка: розділи зʼявляться в міру перенесення функціоналу.")}</Empty>
      </Card>
    </div>
  );
}
