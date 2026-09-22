import { useEffect, useState } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useAuth } from './auth/useAuth';
import { useAuthCheck } from './api/hooks';
import { c, withAlpha } from './theme';
import NewUpload from './pages/NewUpload';
import Shows from './pages/Shows';
import History from './pages/History';
import Archive from './pages/Archive';
import { UploadIndicator } from './components/Dropzone';
import { PresenceRoster } from './components/PresenceRoster';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageLoading } from './components/Skeleton';
import AuthCallback from './pages/AuthCallback';
import AccessDenied from './pages/AccessDenied';
import AuthFailed from './pages/AuthFailed';
import { markSessionHealthy, requestSignin, signOut } from './auth/signin';
import Storage from './pages/Storage';
import { pagedSearch, type PagedSearch } from './components/Pager';

function AuthedLayout() {
  const { user, loading, authFailure } = useAuth();
  const authCheck = useAuthCheck(!!user);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [navAnchor, setNavAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!loading && !user) void requestSignin('route-guard');
  }, [loading, user]);

  // The api accepting a token is the only proof the whole chain works, so it is
  // what resets the loop breaker. Anything short of that leaves the count
  // standing, which is how a bounce-forever session gets stopped.
  useEffect(() => {
    if (authCheck.isSuccess) markSessionHealthy();
  }, [authCheck.isSuccess]);

  // Signing in has failed enough times that continuing would just loop through
  // Zitadel's live SSO session. Say so instead.
  if (authFailure) return <AuthFailed failure={authFailure} />;
  // Never render null here — that blanks the page during auth/redirect (e.g. a
  // session that expired after long idle). Show a loader instead.
  if (loading) return <PageLoading label="loading…" />;
  if (!user) return <PageLoading label="signing in…" />;
  if (authCheck.isError && authCheck.error.message.includes('403')) return <AccessDenied />;
  if (authCheck.isPending) return <PageLoading label="checking access…" />;

  const displayName =
    (user.profile.name as string) ||
    (user.profile.preferred_username as string) ||
    (user.profile.email as string) ||
    'account';

  // Revoke at Zitadel, drop the local session, reset the loop breaker, then
  // force a real login screen — all of it in auth/signin.ts so the failure
  // screen's "sign out" and this button can never drift apart.
  const handleLogout = () => void signOut();

  // Inverted fill marks the current tab — DESIGN.md's emphasis mechanism, since
  // there's no accent colour to lean on.
  const navSx = {
    px: 1.5,
    py: 0.75,
    minHeight: 36,
    fontSize: '0.875rem',
    color: c.muted,
    border: 'none',
    backgroundColor: 'transparent',
    '&:hover': { backgroundColor: 'transparent', color: c.ink, textDecoration: 'none' },
  };
  const navActiveSx = { ...navSx, color: c.paper, backgroundColor: c.ink, '&:hover': { backgroundColor: c.inkHover, color: c.paper } };

  const navLinks = [
    { to: '/', label: 'upload' },
    { to: '/history', label: 'jobs queue' },
    { to: '/archive', label: 'archive' },
    { to: '/storage', label: 'storage' },
  ] as const;
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box
        component="header"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          borderBottom: `2px solid ${c.ink}`,
          backgroundColor: withAlpha(c.page, 0.92),
          backdropFilter: 'blur(8px)',
        }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            flexWrap: 'wrap',
            mx: 'auto',
            maxWidth: 1152,
            minHeight: 64,
            px: { xs: 2, sm: 3 },
            py: 1,
            columnGap: { xs: 2, sm: 3 },
            rowGap: 1,
          }}
        >
          <Button
            component={Link}
            to="/"
            variant="text"
            sx={{
              ...navSx,
              px: 0,
              gap: 1,
              fontSize: '1rem',
              fontWeight: 600,
              color: c.ink,
              letterSpacing: '-0.01em',
            }}
          >
            <Box component="svg" viewBox="0 0 32 32" sx={{ width: 20, height: 20 }} fill="currentColor" aria-hidden>
              <path d="M16 8 L21 14 H17.5 V19 H14.5 V14 H11 Z" />
              <g opacity="0.9">
                <rect x="8" y="22" width="2" height="3" rx="1" />
                <rect x="12" y="21" width="2" height="5" rx="1" />
                <rect x="16" y="22.5" width="2" height="2" rx="1" />
                <rect x="20" y="20" width="2" height="6" rx="1" />
                <rect x="24" y="22" width="2" height="3" rx="1" />
              </g>
            </Box>
            show uploader
          </Button>

          {/* Full row on tablet+; five tabs (since attach recording joined)
              no longer fit a phone's width without wrapping mid-header, so
              phones get a hamburger instead below. */}
          <Stack
            component="nav"
            direction="row"
            spacing={0.25}
            sx={{ alignItems: 'center', display: { xs: 'none', sm: 'flex' } }}
          >
            {navLinks.map((link) => (
              <Button key={link.to} component={Link} to={link.to} variant="text" sx={isActive(link.to) ? navActiveSx : navSx}>
                {link.label}
              </Button>
            ))}
          </Stack>

          <IconButton
            aria-label="menu"
            onClick={(e) => setNavAnchor(e.currentTarget)}
            sx={{ display: { xs: 'inline-flex', sm: 'none' }, color: c.ink }}
          >
            <Box component="svg" viewBox="0 0 24 24" sx={{ width: 22, height: 22 }} fill="none" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </Box>
          </IconButton>
          <Menu anchorEl={navAnchor} open={!!navAnchor} onClose={() => setNavAnchor(null)}>
            {navLinks.map((link) => (
              <MenuItem
                key={link.to}
                component={Link}
                to={link.to}
                selected={isActive(link.to)}
                onClick={() => setNavAnchor(null)}
              >
                {link.label}
              </MenuItem>
            ))}
          </Menu>

          {/* Identity block drops to its own full-width line on phones instead
              of squeezing the nav off the edge. */}
          <Stack
            direction="row"
            spacing={{ xs: 1.5, sm: 2.5 }}
            sx={{ alignItems: 'center', ml: { sm: 'auto' }, width: { xs: '100%', sm: 'auto' } }}
          >
            <PresenceRoster />
            <UploadIndicator />
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', ml: { xs: 'auto', sm: 0 } }}>
              <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
              <Tooltip title={displayName}>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 140 }}>
                  {displayName}
                </Typography>
              </Tooltip>
              <Button
                variant="text"
                onClick={handleLogout}
                sx={{
                  minHeight: 32,
                  fontSize: '0.6875rem',
                  color: c.faint,
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                }}
              >
                log out
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </Box>
      <Box component="main" sx={{ mx: 'auto', maxWidth: 1152, px: { xs: 2, sm: 3 }, py: { xs: 4, sm: 5 } }}>
        {/* Page-level boundary: a crash in one page keeps the header/nav + is
            recoverable, instead of blanking the whole app. */}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </Box>
    </Box>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/callback',
  component: AuthCallback,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  component: AuthedLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: Shows,
});

const uploadRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/upload/$showId',
  component: NewUpload,
});

const archiveRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/archive',
  validateSearch: pagedSearch,
  component: Archive,
});

const storageRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/storage',
  component: Storage,
});

const historyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/history',
  validateSearch: (search: Record<string, unknown>): PagedSearch & { highlight?: string } => ({
    ...pagedSearch(search),
    highlight: typeof search.highlight === 'string' ? search.highlight : undefined,
  }),
  component: History,
});

const routeTree = rootRoute.addChildren([
  callbackRoute,
  authedRoute.addChildren([indexRoute, uploadRoute, historyRoute, archiveRoute, storageRoute]),
]);

// An unknown path renders a small in-app page rather than a blank screen —
// stale bookmarks and mistyped links land somewhere with a way back.
function NotFound() {
  return (
    <Box sx={{ minHeight: '60vh', display: 'grid', placeItems: 'center', textAlign: 'center', px: 2 }}>
      <Box>
        <Typography sx={{ fontWeight: 700, mb: 1 }}>404 — page not found</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          this page does not exist (anymore).
        </Typography>
        <MuiLink component={Link} to="/" sx={{ fontSize: '0.875rem' }}>
          back to uploads
        </MuiLink>
      </Box>
    </Box>
  );
}

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFound });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
