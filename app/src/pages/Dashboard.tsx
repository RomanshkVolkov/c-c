import { Activity, LogOut, Network, Server, User } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { useServers } from "@/hooks/use-servers";
import AddServerDialog from "@/components/AddServerDialog";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  online: "default",
  offline: "destructive",
  pending: "secondary",
  error: "destructive",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const { servers, loading, createServer, deployAgent } = useServers();

  const handleLogout = () => { logout(); navigate("/login"); };
  const initials = session?.username?.slice(0, 2).toUpperCase() ?? "??";
  const online = servers.filter((s) => s.status === "online").length;
  const types = new Set(servers.map((s) => s.type)).size;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          <span className="font-semibold text-lg">CAC</span>
          <Separator orientation="vertical" className="h-5 mx-1" />
          <span className="text-muted-foreground text-sm">VPS Control Plane</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-accent transition-colors">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm">{session?.username}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4" />
                {session?.username}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={handleLogout} variant="destructive">
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Servers</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{servers.length}</div>
              <p className="text-xs text-muted-foreground">registered</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Online</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{online}</div>
              <p className="text-xs text-muted-foreground">reachable</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Cluster Types</CardTitle>
              <Network className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{types}</div>
              <p className="text-xs text-muted-foreground">orchestrators</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Servers</CardTitle>
              <CardDescription>Registered VPS instances</CardDescription>
            </div>
            <AddServerDialog onCreated={createServer} />
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading...</p>
            ) : servers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No servers yet. Add one to get started.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {servers.map((server) => (
                    <TableRow key={server.id}>
                      <TableCell className="font-medium">{server.name}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {server.host}:{server.agentPort}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{server.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[server.status] ?? "secondary"}>
                          {server.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        {(server.status === "pending" || server.status === "error") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deployAgent(server.id)}
                          >
                            {server.status === "error" ? "Retry Deploy" : "Deploy Agent"}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/servers/${server.id}`, { state: server })}
                        >
                          Manage
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
