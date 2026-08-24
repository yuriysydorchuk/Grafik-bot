// «Суші» — вкладка окремого проєкту по суші. Заготовка: функціонал
// поетапно переноситься сюди з окремої програми (паралельні PR-и колеги).
import { Card, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

export default function Sushi() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t("Суші")} subtitle={t("Окремий проєкт — функціонал поетапно переноситься сюди")} />
      <Card>
        <Empty>{t("Сторінка-заготовка: розділи зʼявляться в міру перенесення функціоналу.")}</Empty>
      </Card>
    </div>
  );
}
