import { useT } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SwarmNode } from "@/types/swarm";
import { useServerContext } from "./ServerLayout";

function NodesTab({ nodes }: { nodes: SwarmNode[] }) {
  const { t } = useT();
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {t("common:servers.noNodes")}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("common:servers.thHostname")}</TableHead>
          <TableHead>{t("common:servers.thRole")}</TableHead>
          <TableHead>{t("common:servers.thStatus")}</TableHead>
          <TableHead>{t("common:servers.thAvailability")}</TableHead>
          <TableHead>{t("common:servers.thEngine")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node) => (
          <TableRow key={node.id}>
            <TableCell className="font-medium">{node.hostname}</TableCell>
            <TableCell>
              <Badge
                variant={node.role === "manager" ? "default" : "secondary"}
              >
                {node.role}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={node.status === "ready" ? "default" : "destructive"}
              >
                {node.status}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  node.availability === "active" ? "default" : "secondary"
                }
              >
                {node.availability}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {node.engineVersion}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Los nodos del swarm. */
export default function ServerNodes() {
  const { swarm } = useServerContext();
  return (
    <Card>
      <CardContent className="overflow-auto pt-4">
        <NodesTab nodes={swarm.nodes} />
      </CardContent>
    </Card>
  );
}
