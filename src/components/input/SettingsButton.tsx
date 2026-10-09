import {
  Button,
  Icon,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
  Popover,
} from '@umami/react-zen';
import type { Key } from 'react';
import { useConfig, useLoginQuery, useMessages, useNavigation } from '@/components/hooks';
import { useLogout } from '@/components/hooks/useLogout';
import {
  BookText,
  ExternalLink,
  LifeBuoy,
  LockKeyhole,
  LogOut,
  Settings,
  UserCircle,
} from '@/components/icons';
import { DOCS_URL } from '@/lib/constants';
import { openNewTab } from '@/lib/open-new-tab';

export function SettingsButton() {
  const { t, labels } = useMessages();
  const { user } = useLoginQuery();
  const { router } = useNavigation();
  const { cloudMode } = useConfig();
  const logout = useLogout();

  const handleAction = (id: Key) => {
    const url = id.toString();

    if (url === '/logout' && !cloudMode) {
      logout();
    } else if (cloudMode) {
      if (url === '/docs') {
        openNewTab(DOCS_URL);
      } else {
        window.location.href = url;
      }
    } else {
      router.push(url);
    }
  };

  return (
    <MenuTrigger>
      <Button data-test="button-profile" variant="quiet" autoFocus={false}>
        <Icon>
          <UserCircle />
        </Icon>
      </Button>
      <Popover side="bottom" align="end">
        <Menu>
          <MenuSection title={user.username}>
            <MenuSeparator />
            <MenuItem
              id="/settings"
              icon={<Settings />}
              label={t(labels.settings)}
              onAction={handleAction}
            />
            {!cloudMode && user.isAdmin && (
              <MenuItem
                id="/admin"
                icon={<LockKeyhole />}
                label={t(labels.admin)}
                onAction={handleAction}
              />
            )}
            {cloudMode && (
              <>
                <MenuItem
                  id="/docs"
                  icon={<BookText />}
                  label={t(labels.documentation)}
                  onAction={handleAction}
                >
                  <Icon color="muted">
                    <ExternalLink />
                  </Icon>
                </MenuItem>
                <MenuItem
                  id="/settings/support"
                  icon={<LifeBuoy />}
                  label={t(labels.support)}
                  onAction={handleAction}
                />
              </>
            )}
            <MenuSeparator />
            <MenuItem
              id="/logout"
              icon={<LogOut />}
              label={t(labels.logout)}
              onAction={handleAction}
            />
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
