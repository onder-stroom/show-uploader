import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { c } from '../theme';

/** Who made the app, and for whom. The year is the one the app was made in, not the current one. */
export default function AppFooter() {
  return (
    <Box component="footer" sx={{ mx: 'auto', width: '100%', maxWidth: 1152, px: { xs: 2, sm: 3 }, pb: 4, pt: 2 }}>
      <Typography variant="caption" sx={{ color: c.faint }}>
        © 2026 · developed by{' '}
        <Link href="https://github.com/koraysels" target="_blank" rel="noopener noreferrer">
          Koray
        </Link>{' '}
        for Coming Soon
      </Typography>
    </Box>
  );
}
