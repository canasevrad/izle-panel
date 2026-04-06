import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import Hls from 'hls.js';

type SourceCategory = 'tv' | 'sports' | 'music';

type StreamSource = {
  id: string;
  name: string;
  url: string;
  category: SourceCategory;
  enabled: boolean;
};

type ParsedM3uChannel = {
  name: string;
  url: string;
  category: SourceCategory;
};

type AccessLogEventType = 'login' | 'logout';

type AccessLogRecord = {
  id: string;
  email: string;
  event_type: AccessLogEventType;
  role: 'admin' | 'viewer';
  created_at: string;
};

type TvFocusArea = 'categories' | 'sources' | 'playerControls';
type TvPlayerControl = 'toggleAutoSwitch' | 'previousSource' | 'nextSource' | 'toggleFullscreen';

const STORAGE_KEY = 'stream-hub-sources-v1';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_TABLE = import.meta.env.VITE_SUPABASE_TABLE ?? 'stream_sources';
const SUPABASE_VIEWERS_TABLE = import.meta.env.VITE_SUPABASE_VIEWERS_TABLE ?? 'stream_viewers';
const SUPABASE_ACCESS_LOGS_TABLE = import.meta.env.VITE_SUPABASE_ACCESS_LOGS_TABLE ?? 'stream_access_logs';
const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
const LEGACY_FILM_PREFIX = '[FILM] ';
const MUSIC_CATEGORY_PREFIX = '[MUZIK] ';
const AUTO_SWITCH_MIN_SOURCE_WAIT_MS = 3500;

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;

const defaultSources: StreamSource[] = [
  {
    id: crypto.randomUUID(),
    name: 'TRT Spor (ornek)',
    url: 'https://www.youtube.com/embed/jfKfPfyJRdk',
    category: 'sports',
    enabled: true,
  },
];

function isValidUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function categoryLabel(category: SourceCategory) {
  if (category === 'sports') return 'Mac Yayinlari';
  if (category === 'tv') return 'TV';
  return 'Muzik';
}

function isSourceCategory(value: string): value is SourceCategory {
  return value === 'sports' || value === 'tv' || value === 'music';
}

function stripLegacyFilmPrefix(name: string) {
  return name.startsWith(LEGACY_FILM_PREFIX) ? name.slice(LEGACY_FILM_PREFIX.length) : name;
}

function stripMusicPrefix(name: string) {
  return name.startsWith(MUSIC_CATEGORY_PREFIX) ? name.slice(MUSIC_CATEGORY_PREFIX.length) : name;
}

function getDisplayCategoryFromStored(storedCategory: string, storedName: string): SourceCategory | null {
  // Old builds used "film" and a name prefix. Map them to TV in the new 3-category setup.
  if (storedCategory === 'film') {
    return 'tv';
  }

  if (storedCategory === 'general' && storedName.startsWith(LEGACY_FILM_PREFIX)) {
    return 'tv';
  }

  if (storedCategory === 'general' && storedName.startsWith(MUSIC_CATEGORY_PREFIX)) {
    return 'music';
  }

  if (isSourceCategory(storedCategory)) {
    return storedCategory;
  }

  if (storedCategory === 'general') {
    return 'tv';
  }

  return null;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString('tr-TR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function inferCategoryFromChannel(name: string, groupTitle: string) {
  const normalized = `${name} ${groupTitle}`.toLowerCase();
  if (/(spor|sport|futbol|football|basket|nba|uefa|champions)/.test(normalized)) return 'sports';
  if (/(muzik|music|radio|radyo|fm|hits|pop|rock)/.test(normalized)) return 'music';
  if (/(tv|news|haber|belgesel|movie|sinema|show|kanal)/.test(normalized)) return 'tv';
  return 'tv';
}

function toStoredSourcePayload(name: string, category: SourceCategory) {
  const sanitizedName = stripMusicPrefix(stripLegacyFilmPrefix(name.trim()));
  if (category === 'music') {
    return {
      name: `${MUSIC_CATEGORY_PREFIX}${sanitizedName}`,
      category: 'general',
    };
  }

  return {
    name: sanitizedName,
    category,
  };
}

function getUrlPathExtension(url: string) {
  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname.toLowerCase();
    const match = cleanPath.match(/\.([a-z0-9]+)$/i);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

function isHlsUrl(url: string) {
  return getUrlPathExtension(url) === 'm3u8';
}

function isDirectMediaUrl(url: string) {
  const ext = getUrlPathExtension(url);
  return ['m3u8', 'ts', 'mp4', 'webm', 'ogg', 'mp3', 'aac'].includes(ext);
}

function formatResolution(width: number, height: number) {
  if (!width || !height) return '-';
  return `${width}x${height}`;
}

function readDecodedFrameCount(video: HTMLVideoElement) {
  const withPlaybackQuality = video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
    webkitDecodedFrameCount?: number;
  };

  const quality = withPlaybackQuality.getVideoPlaybackQuality?.();
  if (quality && typeof quality.totalVideoFrames === 'number') {
    return quality.totalVideoFrames;
  }

  if (typeof withPlaybackQuality.webkitDecodedFrameCount === 'number') {
    return withPlaybackQuality.webkitDecodedFrameCount;
  }

  return null;
}

function parseM3uPlaylist(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const channels: ParsedM3uChannel[] = [];
  let pendingName = '';
  let pendingGroup = '';

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const namePart = line.includes(',') ? line.split(',').at(-1) ?? '' : '';
      const groupMatch = line.match(/group-title="([^"]+)"/i);
      pendingName = namePart.trim();
      pendingGroup = groupMatch?.[1]?.trim() ?? '';
      continue;
    }

    if (line.startsWith('#')) continue;
    if (!isValidUrl(line)) {
      pendingName = '';
      pendingGroup = '';
      continue;
    }

    const name = pendingName || `Kanal ${channels.length + 1}`;
    channels.push({
      name,
      url: normalizeUrl(line),
      category: inferCategoryFromChannel(name, pendingGroup),
    });

    pendingName = '';
    pendingGroup = '';
  }

  const uniqueByUrl = new Map<string, ParsedM3uChannel>();
  for (const channel of channels) {
    const key = channel.url.toLowerCase();
    if (!uniqueByUrl.has(key)) {
      uniqueByUrl.set(key, channel);
    }
  }

  return Array.from(uniqueByUrl.values());
}

function downloadTextFile(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

function buildTxtFromChannels(channels: ParsedM3uChannel[]) {
  return channels.map((channel) => `${channel.name} | ${channel.url}`).join('\n');
}

function sanitizeSources(input: unknown) {
  if (!Array.isArray(input)) return [] as StreamSource[];

  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const source = item as Partial<StreamSource>;
      const normalizedUrl = normalizeUrl(String(source.url ?? ''));
      const rawName = String(source.name ?? '').trim();
      const storedCategory = String(source.category ?? 'tv');
      const displayCategory = getDisplayCategoryFromStored(storedCategory, rawName);

      if (!rawName || !isValidUrl(normalizedUrl) || !displayCategory) {
        return null;
      }

      return {
        id: source.id && source.id.trim() ? source.id : crypto.randomUUID(),
        name: stripMusicPrefix(stripLegacyFilmPrefix(rawName)),
        url: normalizedUrl,
        category: displayCategory,
        enabled: source.enabled ?? true,
      } as StreamSource;
    })
    .filter((item): item is StreamSource => Boolean(item));
}

function getLocalSources() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return defaultSources;

  try {
    const parsed = sanitizeSources(JSON.parse(saved));
    return parsed.length > 0 ? parsed : defaultSources;
  } catch {
    return defaultSources;
  }
}

export default function App() {
  const [sources, setSources] = useState<StreamSource[]>([]);
  const [activeSourceId, setActiveSourceId] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newCategory, setNewCategory] = useState<SourceCategory>('sports');
  const [m3uUrl, setM3uUrl] = useState('');
  const [m3uText, setM3uText] = useState('');
  const [m3uFileName, setM3uFileName] = useState('');
  const [showIptvTools, setShowIptvTools] = useState(false);
  const [showSourceList, setShowSourceList] = useState(true);
  const [parsedM3uChannels, setParsedM3uChannels] = useState<ParsedM3uChannel[]>([]);
  const [txtPreviewContent, setTxtPreviewContent] = useState('');
  const [showTxtPreview, setShowTxtPreview] = useState(false);
  const [isImportingM3u, setIsImportingM3u] = useState(false);
  const [iptvMessage, setIptvMessage] = useState('');
  const [iptvMessageType, setIptvMessageType] = useState<'info' | 'success' | 'error'>('info');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editCategory, setEditCategory] = useState<SourceCategory>('sports');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<'all' | SourceCategory>('sports');
  const [iframeKey, setIframeKey] = useState(0);
  const [playerState, setPlayerState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [playerMessage, setPlayerMessage] = useState('Kaynak secip yayini baslatin.');
  const [videoResolution, setVideoResolution] = useState('-');
  const [videoFps, setVideoFps] = useState('-');
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [autoOpenInNewTabOnFail, setAutoOpenInNewTabOnFail] = useState(true);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [storageMode, setStorageMode] = useState<'cloud' | 'local'>(supabase ? 'cloud' : 'local');
  const [hasSourceAccess, setHasSourceAccess] = useState(storageMode === 'local');

  const [adminAuthEmail, setAdminAuthEmail] = useState('');
  const [adminAuthPassword, setAdminAuthPassword] = useState('');
  const [viewerAuthEmail, setViewerAuthEmail] = useState('');
  const [viewerAuthPassword, setViewerAuthPassword] = useState('');
  const [authUserEmail, setAuthUserEmail] = useState('');
  const [adminAuthMessage, setAdminAuthMessage] = useState('');
  const [viewerAuthMessage, setViewerAuthMessage] = useState('');
  const [isAdminAuthSubmitting, setIsAdminAuthSubmitting] = useState(false);
  const [isViewerAuthSubmitting, setIsViewerAuthSubmitting] = useState(false);
  const [showAdminLoginPanel, setShowAdminLoginPanel] = useState(false);
  const [showViewerLoginPanel, setShowViewerLoginPanel] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [showViewerPassword, setShowViewerPassword] = useState(false);
  const [viewerEmailInput, setViewerEmailInput] = useState('');
  const [viewerPasswordInput, setViewerPasswordInput] = useState('');
  const [showNewViewerPassword, setShowNewViewerPassword] = useState(false);
  const [grantViewerEmailInput, setGrantViewerEmailInput] = useState('');
  const [viewerEmails, setViewerEmails] = useState<string[]>([]);
  const [isLoadingViewers, setIsLoadingViewers] = useState(false);
  const [isSavingViewer, setIsSavingViewer] = useState(false);
  const [isCreatingViewerUser, setIsCreatingViewerUser] = useState(false);
  const [accessLogs, setAccessLogs] = useState<AccessLogRecord[]>([]);
  const [isLoadingAccessLogs, setIsLoadingAccessLogs] = useState(false);
  const [accessLogsError, setAccessLogsError] = useState('');
  const [draggingSourceId, setDraggingSourceId] = useState<string | null>(null);
  const [dragOverSourceId, setDragOverSourceId] = useState<string | null>(null);
  const [supportsCloudOrdering, setSupportsCloudOrdering] = useState(true);
  const [isTvMode, setIsTvMode] = useState(false);
  const [focusedSourceId, setFocusedSourceId] = useState('');
  const [tvFocusArea, setTvFocusArea] = useState<TvFocusArea>('sources');
  const [tvCategoryIndex, setTvCategoryIndex] = useState(0);
  const [tvPlayerControlIndex, setTvPlayerControlIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hasCloudConfigured = Boolean(supabase);

  const triedInCycleRef = useRef<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const sourceItemRefs = useRef<Record<string, HTMLElement | null>>({});
  const hlsRef = useRef<Hls | null>(null);
  const autoPlayAttemptKeyRef = useRef('');
  const sourceLoadStartedAtRef = useRef(0);
  const failedAutoOpenAttemptRef = useRef('');

  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };

    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement));
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState as EventListener);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState as EventListener);
    };
  }, []);

  function buildReorderedList(list: StreamSource[], fromId: string, toId: string) {
    const fromIndex = list.findIndex((source) => source.id === fromId);
    const toIndex = list.findIndex((source) => source.id === toId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return list;
    }

    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }

  const isAdmin = storageMode === 'cloud' ? !!ADMIN_EMAIL && authUserEmail === ADMIN_EMAIL : true;
  const canViewContent = storageMode === 'local' ? true : !!authUserEmail && hasSourceAccess;
  const cloudAuthReady = storageMode === 'local' || !!authUserEmail;

  const accessibleSources = useMemo(
    () => (isAdmin ? sources : sources.filter((source) => source.category !== 'music')),
    [isAdmin, sources],
  );

  const activeSource = useMemo(
    () => accessibleSources.find((source) => source.id === activeSourceId) ?? null,
    [accessibleSources, activeSourceId],
  );

  const playbackMode = useMemo<'iframe' | 'video'>(() => {
    if (!activeSource) return 'iframe';
    return isDirectMediaUrl(activeSource.url) ? 'video' : 'iframe';
  }, [activeSource]);

  useEffect(() => {
    if (!isAdmin) {
      setShowSourceList(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin && selectedCategoryFilter === 'music') {
      setSelectedCategoryFilter('sports');
    }
  }, [isAdmin, selectedCategoryFilter]);

  const visibleSources = useMemo(() => {
    if (selectedCategoryFilter === 'all') return accessibleSources;
    return accessibleSources.filter((source) => source.category === selectedCategoryFilter);
  }, [selectedCategoryFilter, accessibleSources]);

  const tvCategoryOptions = useMemo(
    () => [
      { value: 'all' as const, label: 'Tum kategoriler' },
      { value: 'sports' as const, label: 'Mac Yayinlari' },
      { value: 'tv' as const, label: 'TV' },
      ...(isAdmin ? [{ value: 'music' as const, label: 'Muzik' }] : []),
    ],
    [isAdmin],
  );

  const tvPlayerControls = useMemo(
    () =>
      [
        { key: 'toggleAutoSwitch' as const, label: `Oto Gecis: ${autoSwitch ? 'Acik' : 'Kapali'}` },
        { key: 'previousSource' as const, label: 'Onceki Kaynak' },
        { key: 'nextSource' as const, label: 'Sonraki Kaynak' },
        { key: 'toggleFullscreen' as const, label: isFullscreen ? 'Tam Ekrandan Cik' : 'Tam Ekran' },
      ] satisfies Array<{ key: TvPlayerControl; label: string }>,
    [autoSwitch, isFullscreen],
  );

  const tvNavigableSources = useMemo(
    () => visibleSources.filter((source) => source.enabled),
    [visibleSources],
  );

  useEffect(() => {
    if (!isTvMode) {
      setFocusedSourceId('');
      setTvFocusArea('sources');
      return;
    }

    if (!showSourceList) {
      setShowSourceList(true);
    }

    const activeInList = tvNavigableSources.some((source) => source.id === activeSourceId);
    const firstId = tvNavigableSources[0]?.id ?? '';

    setFocusedSourceId((prev) => {
      if (prev && tvNavigableSources.some((source) => source.id === prev)) return prev;
      if (activeInList) return activeSourceId;
      return firstId;
    });
  }, [isTvMode, tvNavigableSources, activeSourceId, showSourceList]);

  useEffect(() => {
    const selectedIndex = tvCategoryOptions.findIndex((option) => option.value === selectedCategoryFilter);
    if (selectedIndex >= 0) {
      setTvCategoryIndex(selectedIndex);
    }
  }, [selectedCategoryFilter, tvCategoryOptions]);

  useEffect(() => {
    if (!isTvMode || tvFocusArea !== 'sources' || !focusedSourceId) return;
    sourceItemRefs.current[focusedSourceId]?.scrollIntoView({ block: 'nearest' });
  }, [isTvMode, tvFocusArea, focusedSourceId]);

  useEffect(() => {
    if (!isTvMode) return;
    if (tvFocusArea === 'sources' && tvNavigableSources.length === 0) {
      setTvFocusArea('categories');
    }
  }, [isTvMode, tvFocusArea, tvNavigableSources.length]);

  useEffect(() => {
    if (!isTvMode || !canViewContent) return;

    function moveArea(direction: 1 | -1) {
      const areas: TvFocusArea[] = ['categories', 'sources', 'playerControls'];
      const activeAreas = areas.filter((area) => (area !== 'sources' ? true : tvNavigableSources.length > 0));
      const currentIndex = Math.max(activeAreas.indexOf(tvFocusArea), 0);
      const nextIndex = (currentIndex + direction + activeAreas.length) % activeAreas.length;
      setTvFocusArea(activeAreas[nextIndex]);
    }

    function activateTvControl(control: TvPlayerControl) {
      if (control === 'toggleAutoSwitch') {
        setAutoSwitch((prev) => !prev);
      }
      if (control === 'previousSource') {
        switchToPreviousSource();
      }
      if (control === 'nextSource') {
        switchToNextSource();
      }
      if (control === 'toggleFullscreen') {
        void toggleFullscreen();
      }
    }

    function handleTvKeyNavigation(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (tvFocusArea === 'sources' && tvNavigableSources.length > 0) {
          const currentIndex = tvNavigableSources.findIndex((source) => source.id === focusedSourceId);
          const safeIndex = currentIndex >= 0 ? currentIndex : 0;
          const nextIndex = (safeIndex + 1) % tvNavigableSources.length;
          setFocusedSourceId(tvNavigableSources[nextIndex].id);
        } else {
          moveArea(1);
        }
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (tvFocusArea === 'sources' && tvNavigableSources.length > 0) {
          const currentIndex = tvNavigableSources.findIndex((source) => source.id === focusedSourceId);
          const safeIndex = currentIndex >= 0 ? currentIndex : 0;
          const previousIndex = (safeIndex - 1 + tvNavigableSources.length) % tvNavigableSources.length;
          setFocusedSourceId(tvNavigableSources[previousIndex].id);
        } else {
          moveArea(-1);
        }
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (tvFocusArea === 'categories') {
          setTvCategoryIndex((prev) => (prev + 1) % tvCategoryOptions.length);
        } else if (tvFocusArea === 'playerControls') {
          setTvPlayerControlIndex((prev) => (prev + 1) % tvPlayerControls.length);
        } else {
          moveArea(1);
        }
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (tvFocusArea === 'categories') {
          setTvCategoryIndex((prev) => (prev - 1 + tvCategoryOptions.length) % tvCategoryOptions.length);
        } else if (tvFocusArea === 'playerControls') {
          setTvPlayerControlIndex((prev) => (prev - 1 + tvPlayerControls.length) % tvPlayerControls.length);
        } else {
          moveArea(-1);
        }
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (tvFocusArea === 'categories') {
          const option = tvCategoryOptions[tvCategoryIndex];
          if (option) {
            setSelectedCategoryFilter(option.value);
          }
          return;
        }

        if (tvFocusArea === 'sources') {
          const currentIndex = tvNavigableSources.findIndex((source) => source.id === focusedSourceId);
          const safeIndex = currentIndex >= 0 ? currentIndex : 0;
          const targetSource = tvNavigableSources[safeIndex];
          if (targetSource) {
            selectSource(targetSource.id);
          }
          return;
        }

        const control = tvPlayerControls[tvPlayerControlIndex];
        if (control) {
          activateTvControl(control.key);
        }
      }
    }

    window.addEventListener('keydown', handleTvKeyNavigation);
    return () => window.removeEventListener('keydown', handleTvKeyNavigation);
  }, [
    isTvMode,
    canViewContent,
    tvNavigableSources,
    focusedSourceId,
    tvFocusArea,
    tvCategoryOptions,
    tvCategoryIndex,
    tvPlayerControls,
    tvPlayerControlIndex,
  ]);

  useEffect(() => {
    if (!supabase) return;

    let isMounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      const sessionEmail = data.session?.user.email?.toLowerCase() ?? '';
      setAuthUserEmail(sessionEmail);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUserEmail(session?.user.email?.toLowerCase() ?? '');
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (storageMode !== 'cloud' || !isAdmin) {
      setViewerEmails([]);
      return;
    }

    void loadViewerEmails();
  }, [storageMode, isAdmin]);

  useEffect(() => {
    if (storageMode !== 'cloud' || !isAdmin) {
      setAccessLogs([]);
      setAccessLogsError('');
      return;
    }

    void loadAccessLogs();
  }, [storageMode, isAdmin]);

  useEffect(() => {
    let isMounted = true;

    async function loadSources() {
      if (!isMounted) return;
      setIsLoadingSources(true);

      if (!supabase) {
        setSources(getLocalSources());
        setStorageMode('local');
        setHasSourceAccess(true);
        setIsLoadingSources(false);
        return;
      }

      setStorageMode('cloud');
      setHasSourceAccess(false);

      if (!authUserEmail) {
        setSources([]);
        setPlayerState('idle');
        setPlayerMessage('Kaynaklari gormek icin giris yapin.');
        setIsLoadingSources(false);
        return;
      }

      const primaryQuery = await supabase
        .from(SUPABASE_TABLE)
        .select('id, name, url, category, enabled, sort_order, created_at')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });

      let data: unknown = primaryQuery.data;
      let error = primaryQuery.error;

      if (error && (error.code === '42703' || error.message.toLowerCase().includes('sort_order'))) {
        const fallbackQuery = await supabase
          .from(SUPABASE_TABLE)
          .select('id, name, url, category, enabled, created_at')
          .order('created_at', { ascending: true });

        data = fallbackQuery.data;
        error = fallbackQuery.error;
        setSupportsCloudOrdering(false);
      } else {
        setSupportsCloudOrdering(true);
      }

      if (!isMounted) return;

      if (error) {
        setSources([]);
        setHasSourceAccess(false);
        setPlayerState('failed');
        if (error.message.toLowerCase().includes('permission') || error.code === '42501') {
          setPlayerMessage('Bu hesapla izleme izni yok. Admin seni izin listesine eklemeli.');
        } else {
          setPlayerMessage(`Bulut kaynaklari yuklenemedi: ${error.message}`);
        }
        setIsLoadingSources(false);
        return;
      }

      setSources(sanitizeSources(data));
      setHasSourceAccess(true);
      setPlayerState('idle');
      setPlayerMessage('Kaynaklar buluttan yuklendi.');
      setIsLoadingSources(false);
    }

    void loadSources();

    return () => {
      isMounted = false;
    };
  }, [authUserEmail]);

  useEffect(() => {
    if (isLoadingSources || storageMode !== 'local') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  }, [sources, storageMode, isLoadingSources]);

  useEffect(() => {
    if (accessibleSources.some((source) => source.id === activeSourceId)) return;

    const fallback = accessibleSources.find((source) => source.enabled) ?? accessibleSources[0];
    setActiveSourceId(fallback?.id ?? '');
    triedInCycleRef.current = new Set(fallback ? [fallback.id] : []);
  }, [accessibleSources, activeSourceId]);

  useEffect(() => {
    if (!activeSource) {
      setPlayerState('idle');
      setPlayerMessage('Kaynak secip yayini baslatin.');
      setVideoResolution('-');
      setVideoFps('-');
      autoPlayAttemptKeyRef.current = '';
      return;
    }

    if (!activeSource.enabled) {
      setPlayerState('failed');
      setPlayerMessage('Secili kaynak pasif. Baska bir kaynak secin.');
      return;
    }

    if (window.location.protocol === 'https:' && activeSource.url.startsWith('http://') && playbackMode === 'video') {
      setPlayerState('failed');
      setPlayerMessage('HTTPS sitede HTTP medya (.ts/.m3u8) acilamaz. Mumkunse HTTPS kaynak kullanin.');
      return;
    }

    setPlayerState('loading');
    sourceLoadStartedAtRef.current = Date.now();
    autoPlayAttemptKeyRef.current = '';
    setPlayerMessage(
      playbackMode === 'video'
        ? `${activeSource.name} dahili oynaticida aciliyor...`
        : `${activeSource.name} iframe baglantisi aciliyor...`,
    );

    if (playbackMode === 'iframe') {
      setIframeKey((prev) => prev + 1);
    }
  }, [activeSource, playbackMode]);

  useEffect(() => {
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!activeSource || !canViewContent || !activeSource.enabled || playbackMode !== 'video') return;
    const video = videoRef.current;
    if (!video) return;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.pause();
    video.removeAttribute('src');
    video.load();

    let localHls: Hls | null = null;

    if (isHlsUrl(activeSource.url)) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = activeSource.url;
        video.load();
        return () => {
          video.pause();
          video.removeAttribute('src');
          video.load();
        };
      }

      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        localHls = hls;
        hlsRef.current = hls;
        hls.loadSource(activeSource.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setPlayerState('failed');
          setPlayerMessage('HLS oynatici bu yayini acamadi. Sonraki kaynagi deneyin.');
        });
        return () => {
          localHls?.destroy();
          if (hlsRef.current === localHls) {
            hlsRef.current = null;
          }
          video.pause();
          video.removeAttribute('src');
          video.load();
        };
      }

      setPlayerState('failed');
      setPlayerMessage('Tarayici HLS destegi vermiyor. M3U8 icin farkli tarayici deneyin.');
      return () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    }

    video.src = activeSource.url;
    video.load();

    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [activeSource, canViewContent, playbackMode]);

  useEffect(() => {
    if (playbackMode === 'video') return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setVideoResolution('Iframe kaynagi');
    setVideoFps('Olcum yok');
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }, [playbackMode]);

  useEffect(() => {
    if (playbackMode !== 'video' || !activeSource || !canViewContent || !activeSource.enabled) {
      if (playbackMode === 'video') {
        setVideoResolution('-');
        setVideoFps('-');
      }
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    let rafId = 0;
    let lastFrameCount = readDecodedFrameCount(video);
    let lastFrameTimestamp = performance.now();
    let lastUiUpdate = performance.now();

    const updateResolution = () => {
      setVideoResolution(formatResolution(video.videoWidth, video.videoHeight));
    };

    const tick = (now: number) => {
      const currentFrames = readDecodedFrameCount(video);

      if (currentFrames !== null && lastFrameCount !== null) {
        const elapsed = now - lastFrameTimestamp;
        if (elapsed >= 1000) {
          const deltaFrames = currentFrames - lastFrameCount;
          const fps = deltaFrames / (elapsed / 1000);
          setVideoFps(Number.isFinite(fps) && fps >= 0 ? `${fps.toFixed(1)} FPS` : '-');
          lastFrameCount = currentFrames;
          lastFrameTimestamp = now;
          lastUiUpdate = now;
        }
      } else if (now - lastUiUpdate >= 1500) {
        setVideoFps('Tarayici olcemiyor');
        lastUiUpdate = now;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    const onLoadedMetadata = () => {
      updateResolution();
    };

    const onPlaying = () => {
      updateResolution();
      lastFrameCount = readDecodedFrameCount(video);
      lastFrameTimestamp = performance.now();
    };

    const onEndedOrPause = () => {
      setVideoFps('-');
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('resize', onLoadedMetadata);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onEndedOrPause);
    video.addEventListener('ended', onEndedOrPause);

    updateResolution();
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('resize', onLoadedMetadata);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onEndedOrPause);
      video.removeEventListener('ended', onEndedOrPause);
    };
  }, [playbackMode, activeSource, canViewContent]);

  useEffect(() => {
    if (playerState !== 'loading') return;

    const timeoutId = window.setTimeout(() => {
      setPlayerState('failed');
      setPlayerMessage('Yayin yuklenemedi veya iframe engellendi. Sonraki kaynaga gecebilirsiniz.');
    }, 8000);

    return () => window.clearTimeout(timeoutId);
  }, [playerState, iframeKey]);

  useEffect(() => {
    if (playerState !== 'failed' || !autoSwitch || !activeSource) return;

    triedInCycleRef.current.add(activeSource.id);
    const enabled = visibleSources.filter((source) => source.enabled);
    const currentIndex = enabled.findIndex((source) => source.id === activeSource.id);
    if (currentIndex === -1) return;

    let nextSource: StreamSource | null = null;
    for (let i = 1; i <= enabled.length; i += 1) {
      const candidate = enabled[(currentIndex + i) % enabled.length];
      if (!triedInCycleRef.current.has(candidate.id)) {
        nextSource = candidate;
        break;
      }
    }

    if (!nextSource) {
      setPlayerMessage('Tum etkin kaynaklar denendi. Manuel kaynak secip tekrar deneyin.');
      return;
    }

    const elapsedSinceLoad = Date.now() - sourceLoadStartedAtRef.current;
    const switchDelay = Math.max(1200, AUTO_SWITCH_MIN_SOURCE_WAIT_MS - elapsedSinceLoad);

    const switchTimer = window.setTimeout(() => {
      setActiveSourceId(nextSource!.id);
    }, switchDelay);

    return () => window.clearTimeout(switchTimer);
  }, [playerState, autoSwitch, activeSource, visibleSources]);

  useEffect(() => {
    if (playerState === 'failed') return;
    failedAutoOpenAttemptRef.current = '';
  }, [playerState, activeSourceId]);

  useEffect(() => {
    if (playerState !== 'failed' || !autoOpenInNewTabOnFail || !activeSource) return;

    const attemptKey = `${activeSource.id}:${activeSource.url}`;
    if (failedAutoOpenAttemptRef.current === attemptKey) return;
    failedAutoOpenAttemptRef.current = attemptKey;

    const popup = window.open(activeSource.url, '_blank', 'noopener,noreferrer');
    if (popup) {
      setPlayerMessage('Kaynak oynatilamadi. Kaynak sayfasi yeni sekmede acildi.');
    } else {
      setPlayerMessage('Kaynak oynatilamadi. Otomatik yeni sekme engellendi; Yeni Sekmede Ac butonunu kullanin.');
    }
  }, [playerState, autoOpenInNewTabOnFail, activeSource]);

  function requireAdmin() {
    if (storageMode !== 'cloud') return true;
    if (!ADMIN_EMAIL) {
      setPlayerState('failed');
      setPlayerMessage('Admin e-posta ayari eksik. Netlify env degiskenine VITE_ADMIN_EMAIL ekleyin.');
      return false;
    }
    if (!cloudAuthReady || !isAdmin) {
      setPlayerState('failed');
      setPlayerMessage('Duzenleme yetkisi yok. Sadece admin e-postasi ile giris yapan kullanici duzenleyebilir.');
      return false;
    }
    return true;
  }

  async function loadAccessLogs() {
    if (!supabase || !isAdmin || storageMode !== 'cloud') {
      setAccessLogs([]);
      setAccessLogsError('');
      return;
    }

    setIsLoadingAccessLogs(true);
    const { data, error } = await supabase
      .from(SUPABASE_ACCESS_LOGS_TABLE)
      .select('id, email, event_type, role, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    setIsLoadingAccessLogs(false);

    if (error) {
      setAccessLogs([]);
      if (error.message.toLowerCase().includes('does not exist') || error.code === '42P01') {
        setAccessLogsError('Giris kayit tablosu bulunamadi. Supabase SQL adimini eklemen gerekiyor.');
      } else if (error.code === '42501' || error.message.toLowerCase().includes('permission')) {
        setAccessLogsError('Giris kayitlarini gormek icin tablo policy ayarlarini kontrol et.');
      } else {
        setAccessLogsError(`Giris kayitlari yuklenemedi: ${error.message}`);
      }
      return;
    }

    setAccessLogsError('');
    setAccessLogs((data ?? []) as AccessLogRecord[]);
  }

  async function logAccessEvent(eventType: AccessLogEventType, email: string) {
    if (!supabase || storageMode !== 'cloud') return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return;

    const role: AccessLogRecord['role'] = normalizedEmail === ADMIN_EMAIL ? 'admin' : 'viewer';

    const { error } = await supabase.from(SUPABASE_ACCESS_LOGS_TABLE).insert({
      email: normalizedEmail,
      event_type: eventType,
      role,
    });

    if (error) {
      return;
    }

    if (isAdmin) {
      await loadAccessLogs();
    }
  }

  async function loginWithPassword(email: string, password: string) {
    if (!supabase) return { ok: false as const, message: 'Supabase baglantisi yok.', email: '' };

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return { ok: false as const, message: 'Lutfen e-posta girin.', email: '' };
    if (!isValidEmail(normalizedEmail)) return { ok: false as const, message: 'Gecerli bir e-posta girin.', email: '' };
    if (!password.trim()) return { ok: false as const, message: 'Lutfen sifreni gir.', email: '' };

    const { error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error) {
      return { ok: false as const, message: `Giris yapilamadi: ${error.message}`, email: normalizedEmail };
    }

    return { ok: true as const, message: 'Giris basarili.', email: normalizedEmail };
  }

  async function handleAdminLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAdminEmail = adminAuthEmail.trim().toLowerCase();
    if (ADMIN_EMAIL && normalizedAdminEmail !== ADMIN_EMAIL) {
      setAdminAuthMessage('Bu alan sadece yonetici e-postasi icindir.');
      return;
    }

    setIsAdminAuthSubmitting(true);
    setViewerAuthMessage('');

    const result = await loginWithPassword(adminAuthEmail, adminAuthPassword);

    setIsAdminAuthSubmitting(false);
    setAdminAuthMessage(result.message);
    if (result.ok) {
      await logAccessEvent('login', result.email);
      setAdminAuthPassword('');
    }
  }

  async function handleViewerLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsViewerAuthSubmitting(true);
    setAdminAuthMessage('');

    const result = await loginWithPassword(viewerAuthEmail, viewerAuthPassword);

    setIsViewerAuthSubmitting(false);
    setViewerAuthMessage(result.message);
    if (result.ok) {
      await logAccessEvent('login', result.email);
      setViewerAuthPassword('');
    }
  }

  async function handleLogout() {
    if (!supabase) return;
    const emailToLog = authUserEmail;
    if (emailToLog) {
      await logAccessEvent('logout', emailToLog);
    }
    await supabase.auth.signOut();
    setViewerEmails([]);
    setAdminAuthMessage('Cikis yapildi.');
    setViewerAuthMessage('Cikis yapildi.');
  }

  async function loadViewerEmails() {
    if (!supabase || !isAdmin) {
      setViewerEmails([]);
      return;
    }

    setIsLoadingViewers(true);
    if (ADMIN_EMAIL) {
      await supabase.from(SUPABASE_VIEWERS_TABLE).upsert({ email: ADMIN_EMAIL }, { onConflict: 'email' });
    }

    const { data, error } = await supabase
      .from(SUPABASE_VIEWERS_TABLE)
      .select('email')
      .order('email', { ascending: true });
    setIsLoadingViewers(false);

    if (error) {
      setPlayerState('failed');
      setPlayerMessage(`Izin listesi yuklenemedi: ${error.message}`);
      return;
    }

    const sanitized = (data ?? [])
      .map((item) => String(item.email ?? '').trim().toLowerCase())
      .filter(Boolean);
    setViewerEmails(Array.from(new Set(sanitized)));
  }

  async function addViewerEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireAdmin() || !supabase) return;

    const normalized = grantViewerEmailInput.trim().toLowerCase();
    if (!isValidEmail(normalized)) {
      setPlayerState('failed');
      setPlayerMessage('Gecerli bir e-posta adresi girin.');
      return;
    }

    setIsSavingViewer(true);
    const { error } = await supabase.from(SUPABASE_VIEWERS_TABLE).upsert({ email: normalized }, { onConflict: 'email' });
    setIsSavingViewer(false);

    if (error) {
      setPlayerState('failed');
      setPlayerMessage(`Izinli e-posta eklenemedi: ${error.message}`);
      return;
    }

    setGrantViewerEmailInput('');
    setPlayerState('idle');
    setPlayerMessage('E-posta izin listesine eklendi.');
    await loadViewerEmails();
  }

  async function createViewerAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireAdmin() || !supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;

    const normalizedEmail = viewerEmailInput.trim().toLowerCase();
    const password = viewerPasswordInput.trim();

    if (!isValidEmail(normalizedEmail)) {
      setPlayerState('failed');
      setPlayerMessage('Gecerli bir e-posta adresi girin.');
      return;
    }

    if (password.length < 6) {
      setPlayerState('failed');
      setPlayerMessage('Sifre en az 6 karakter olmali.');
      return;
    }

    setIsCreatingViewerUser(true);

    let canGrantAccess = true;
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        const message = payload?.message ?? `HTTP ${response.status}`;
        if (!message.toLowerCase().includes('already')) {
          canGrantAccess = false;
          setPlayerState('failed');
          setPlayerMessage(`Kullanici olusturulamadi: ${message}`);
        }
      }
    } catch {
      canGrantAccess = false;
      setPlayerState('failed');
      setPlayerMessage('Kullanici olusturulamadi. Ag baglantisini kontrol edin.');
    }

    if (!canGrantAccess) {
      setIsCreatingViewerUser(false);
      return;
    }

    const { error } = await supabase
      .from(SUPABASE_VIEWERS_TABLE)
      .upsert({ email: normalizedEmail, added_by: authUserEmail || ADMIN_EMAIL }, { onConflict: 'email' });
    setIsCreatingViewerUser(false);

    if (error) {
      setPlayerState('failed');
      setPlayerMessage(`Kullanici acildi ama izin atanamadi: ${error.message}`);
      return;
    }

    setViewerEmailInput('');
    setViewerPasswordInput('');
    setPlayerState('idle');
    setPlayerMessage('Kullanici olusturuldu ve izleme izni verildi.');
    await loadViewerEmails();
  }

  async function removeViewerEmail(email: string) {
    if (!requireAdmin() || !supabase) return;

    const normalized = email.trim().toLowerCase();
    if (normalized === ADMIN_EMAIL) {
      setPlayerState('failed');
      setPlayerMessage('Admin e-postasi izin listesinden silinemez.');
      return;
    }

    setIsSavingViewer(true);
    const { error } = await supabase.from(SUPABASE_VIEWERS_TABLE).delete().eq('email', normalized);
    setIsSavingViewer(false);

    if (error) {
      setPlayerState('failed');
      setPlayerMessage(`Izinli e-posta silinemedi: ${error.message}`);
      return;
    }

    setPlayerState('idle');
    setPlayerMessage('E-posta izin listesinden kaldirildi.');
    await loadViewerEmails();
  }

  async function handleAddSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireAdmin()) return;

    if (!newName.trim()) return;
    const normalizedUrl = normalizeUrl(newUrl);
    if (!isValidUrl(normalizedUrl)) {
      setPlayerState('failed');
      setPlayerMessage('Kaynak URL gecersiz. http veya https ile baslayan bir link girin.');
      return;
    }

    const draft: StreamSource = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      url: normalizedUrl,
      category: newCategory,
      enabled: true,
    };

    if (storageMode === 'cloud' && supabase) {
      setIsSaving(true);
      const sortOrder = sources.length + 1;
      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .insert({
          name: toStoredSourcePayload(draft.name, draft.category).name,
          url: draft.url,
          category: toStoredSourcePayload(draft.name, draft.category).category,
          enabled: draft.enabled,
          ...(supportsCloudOrdering ? { sort_order: sortOrder } : {}),
        })
        .select('id, name, url, category, enabled')
        .single();
      setIsSaving(false);

      if (error) {
        setPlayerState('failed');
        setPlayerMessage(`Kaynak buluta kaydedilemedi: ${error.message}`);
        return;
      }

      const parsed = sanitizeSources([data]);
      if (parsed.length === 0) {
        setPlayerState('failed');
        setPlayerMessage('Kaynak kaydedildi ama veri okunamadi. Tablo kolonlarini kontrol edin.');
        return;
      }

      setSources((prev) => [...prev, parsed[0]]);
      setActiveSourceId(parsed[0].id);
      triedInCycleRef.current = new Set([parsed[0].id]);
    } else {
      setSources((prev) => [...prev, draft]);
      setActiveSourceId(draft.id);
      triedInCycleRef.current = new Set([draft.id]);
    }

    setNewName('');
    setNewUrl('');
    setNewCategory('sports');
  }

  async function saveImportedChannels(channels: ParsedM3uChannel[]) {
    if (!requireAdmin()) return;
    if (channels.length === 0) {
      setPlayerState('failed');
      setPlayerMessage('M3U listesinde gecerli kanal bulunamadi.');
      setIptvMessageType('error');
      setIptvMessage('M3U listesinde kanal URL bulunamadi. M3U iceriginin #EXTM3U formatinda oldugunu kontrol et.');
      return;
    }

    const existingUrls = new Set(sources.map((source) => source.url.toLowerCase()));
    const deduped = channels.filter((channel) => !existingUrls.has(channel.url.toLowerCase()));
    if (deduped.length === 0) {
      setPlayerState('idle');
      setPlayerMessage('M3U listesinde yeni bir kaynak yok. Tum URLler zaten ekli.');
      setIptvMessageType('info');
      setIptvMessage('M3U okundu fakat tum linkler listede zaten mevcut.');
      return;
    }

    const limited = deduped.slice(0, 400);

    if (storageMode === 'cloud' && supabase) {
      setIsImportingM3u(true);
      const baseSortOrder = sources.length;
      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .insert(
          limited.map((item, index) => ({
            name: toStoredSourcePayload(item.name, item.category).name,
            url: item.url,
            category: toStoredSourcePayload(item.name, item.category).category,
            enabled: true,
            ...(supportsCloudOrdering ? { sort_order: baseSortOrder + index + 1 } : {}),
          })),
        )
        .select('id, name, url, category, enabled');
      setIsImportingM3u(false);

      if (error) {
        setPlayerState('failed');
        setPlayerMessage(`M3U kaynaklari buluta kaydedilemedi: ${error.message}`);
        setIptvMessageType('error');
        setIptvMessage(`Buluta kayit basarisiz: ${error.message}`);
        return;
      }

      const parsed = sanitizeSources(data ?? []);
      if (parsed.length > 0) {
        setSources((prev) => [...prev, ...parsed]);
        setActiveSourceId(parsed[0].id);
        triedInCycleRef.current = new Set([parsed[0].id]);
      }
    } else {
      const prepared = limited.map((item) => ({
        id: crypto.randomUUID(),
        name: item.name,
        url: item.url,
        category: item.category,
        enabled: true,
      }));
      setSources((prev) => [...prev, ...prepared]);
      if (prepared[0]) {
        setActiveSourceId(prepared[0].id);
        triedInCycleRef.current = new Set([prepared[0].id]);
      }
    }

    const limitMessage = limited.length < deduped.length ? ' Ilk 400 kaynak eklendi.' : '';
    setPlayerState('idle');
    setPlayerMessage(`${limited.length} IPTV kaynagi eklendi.${limitMessage}`);
    setIptvMessageType('success');
    setIptvMessage(`${limited.length} kanal eklendi.${limitMessage}`);
  }

  function isMixedContentUrl(url: string) {
    return window.location.protocol === 'https:' && /^http:\/\//i.test(url);
  }

  async function importM3uFromUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requireAdmin()) return;

    const normalized = normalizeUrl(m3uUrl);
    if (!isValidUrl(normalized)) {
      setPlayerState('failed');
      setPlayerMessage('M3U URL gecersiz.');
      setIptvMessageType('error');
      setIptvMessage('URL gecersiz. http:// veya https:// ile baslayan bir adres gir.');
      return;
    }

    if (isMixedContentUrl(normalized)) {
      setPlayerState('failed');
      setPlayerMessage('HTTPS siteden HTTP M3U URL cekilemez (mixed content).');
      setIptvMessageType('error');
      setIptvMessage('Bu link http:// ile basliyor. HTTPS sayfadan cekilemez. Linki https yap veya dosyayi indirip yukle.');
      return;
    }

    setIsImportingM3u(true);
    setIptvMessageType('info');
    setIptvMessage('M3U URL okunuyor...');
    try {
      const response = await fetch(normalized);
      if (!response.ok) {
        setPlayerState('failed');
        setPlayerMessage(`M3U dosyasi cekilemedi: HTTP ${response.status}`);
        setIptvMessageType('error');
        setIptvMessage(`URL yanit vermedi (HTTP ${response.status}). Linki tarayicida acip dosyanin inebildigini kontrol et.`);
        return;
      }

      const raw = await response.text();
      setM3uText(raw);
      setM3uFileName('URL kaynagi');
      const parsedChannels = parseM3uPlaylist(raw);
      await saveImportedChannels(parsedChannels);
      setParsedM3uChannels(parsedChannels);
      setTxtPreviewContent(buildTxtFromChannels(parsedChannels));
      setShowTxtPreview(false);
      setM3uUrl('');
    } catch {
      setPlayerState('failed');
      setPlayerMessage('M3U URL cekilemedi. Kaynak CORS engelliyor olabilir, metni yapistirarak deneyin.');
      setIptvMessageType('error');
      setIptvMessage('Tarayici URLi okuyamadi. CORS veya operator engeli olabilir. Dosyayi indirip alttan yuklemek en garantili yoldur.');
    } finally {
      setIsImportingM3u(false);
    }
  }

  async function importM3uFromText() {
    if (!requireAdmin()) return;

    if (!m3uText.trim()) {
      setPlayerState('failed');
      setPlayerMessage('M3U metni bos olamaz.');
      setIptvMessageType('error');
      setIptvMessage('Metin bos. M3U icerigini yapistir veya dosya yukle.');
      return;
    }

    setIsImportingM3u(true);
    const parsedChannels = parseM3uPlaylist(m3uText);
    await saveImportedChannels(parsedChannels);
    setParsedM3uChannels(parsedChannels);
    setTxtPreviewContent(buildTxtFromChannels(parsedChannels));
    setShowTxtPreview(false);
    setIsImportingM3u(false);
  }

  function prepareTxtFromLoadedM3u() {
    if (!requireAdmin()) return;

    if (!m3uText.trim()) {
      setPlayerState('failed');
      setPlayerMessage('TXT olusturmak icin once M3U linki veya dosyasi yukle.');
      setIptvMessageType('error');
      setIptvMessage('M3U icerigi bulunamadi. Once linkten cek veya dosya yukle.');
      return;
    }

    const parsedChannels = parseM3uPlaylist(m3uText);
    if (parsedChannels.length === 0) {
      setPlayerState('failed');
      setPlayerMessage('Yuklenen M3U iceriginde donusturulecek link bulunamadi.');
      setIptvMessageType('error');
      setIptvMessage('M3U formatini kontrol et. #EXTINF ve URL satirlari bulunamadi.');
      return;
    }

    setParsedM3uChannels(parsedChannels);
    setTxtPreviewContent(buildTxtFromChannels(parsedChannels));
    setShowTxtPreview(true);
    setPlayerState('idle');
    setPlayerMessage(`${parsedChannels.length} kanal icin TXT hazirlandi (Kanal Adi | URL).`);
    setIptvMessageType('success');
    setIptvMessage(`${parsedChannels.length} kanal donusturuldu. TXT onizleme acik.`);
  }

  function downloadPreparedTxt() {
    if (!requireAdmin()) return;
    if (!txtPreviewContent.trim()) {
      setPlayerState('failed');
      setPlayerMessage('Indirilecek TXT hazir degil. Once TXT olustur.');
      return;
    }

    downloadTextFile(txtPreviewContent, 'iptv-name-url.txt');
    setPlayerState('idle');
    setPlayerMessage('TXT dosyasi indirildi.');
  }

  async function handleM3uFileUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!requireAdmin()) return;

    const file = event.target.files?.[0];
    if (!file) return;

    setIsImportingM3u(true);
    setIptvMessageType('info');
    setIptvMessage('M3U dosyasi okunuyor...');

    try {
      const raw = await file.text();
      setM3uFileName(file.name);
      setM3uText(raw);
      const parsedChannels = parseM3uPlaylist(raw);
      setParsedM3uChannels(parsedChannels);
      setTxtPreviewContent('');
      setShowTxtPreview(false);
      if (parsedChannels.length === 0) {
        setIptvMessageType('error');
        setIptvMessage('Dosya okundu ama M3U kanal satiri bulunamadi. Farkli bir dosya deneyin.');
      } else {
        setIptvMessageType('success');
        setIptvMessage(`${parsedChannels.length} kanal algilandi. Simdi TXT olusturup goruntuleyebilir veya indirebilirsin.`);
      }
    } catch {
      setIptvMessageType('error');
      setIptvMessage('Dosya okunamadi. Dosyayi yeniden secip tekrar deneyin.');
    } finally {
      setIsImportingM3u(false);
      event.target.value = '';
    }
  }

  async function removeSource(id: string) {
    if (!requireAdmin()) return;

    if (storageMode === 'cloud' && supabase) {
      setIsSaving(true);
      const { error } = await supabase.from(SUPABASE_TABLE).delete().eq('id', id);
      setIsSaving(false);
      if (error) {
        setPlayerState('failed');
        setPlayerMessage(`Kaynak silinemedi: ${error.message}`);
        return;
      }
    }

    setSources((prev) => prev.filter((source) => source.id !== id));
    if (editingId === id) {
      setEditingId(null);
    }
    if (activeSourceId === id) {
      const fallback = sources.find((source) => source.id !== id && source.enabled);
      setActiveSourceId(fallback?.id ?? '');
      triedInCycleRef.current = new Set(fallback ? [fallback.id] : []);
    }
  }

  function startEditing(source: StreamSource) {
    if (!requireAdmin()) return;
    setEditingId(source.id);
    setEditName(source.name);
    setEditUrl(source.url);
    setEditCategory(source.category);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditName('');
    setEditUrl('');
    setEditCategory('sports');
  }

  async function saveSourceChanges(id: string) {
    if (!requireAdmin()) return;

    if (!editName.trim()) {
      setPlayerState('failed');
      setPlayerMessage('Kaynak adi bos olamaz.');
      return;
    }

    const normalizedUrl = normalizeUrl(editUrl);
    if (!isValidUrl(normalizedUrl)) {
      setPlayerState('failed');
      setPlayerMessage('Duzenleme kaydedilemedi. Gecerli bir URL girin.');
      return;
    }

    if (storageMode === 'cloud' && supabase) {
      setIsSaving(true);
      const { error } = await supabase
        .from(SUPABASE_TABLE)
        .update({
          name: toStoredSourcePayload(editName, editCategory).name,
          url: normalizedUrl,
          category: toStoredSourcePayload(editName, editCategory).category,
        })
        .eq('id', id);
      setIsSaving(false);

      if (error) {
        setPlayerState('failed');
        setPlayerMessage(`Duzenleme kaydedilemedi: ${error.message}`);
        return;
      }
    }

    setSources((prev) =>
      prev.map((source) =>
        source.id === id
          ? {
              ...source,
              name: editName.trim(),
              url: normalizedUrl,
              category: editCategory,
            }
          : source,
      ),
    );
    setEditingId(null);
    setPlayerState('idle');
    setPlayerMessage('Kaynak bilgileri guncellendi.');
  }

  function selectSource(id: string) {
    triedInCycleRef.current = new Set([id]);
    if (isTvMode) {
      setFocusedSourceId(id);
    }
    setActiveSourceId(id);
  }

  async function persistSourceOrder(nextSources: StreamSource[]) {
    if (!isAdmin || storageMode !== 'cloud' || !supabase || !supportsCloudOrdering) {
      return;
    }

    const updates = nextSources.map((source, index) =>
      supabase
        .from(SUPABASE_TABLE)
        .update({ sort_order: index + 1 })
        .eq('id', source.id),
    );

    const results = await Promise.all(updates);
    const firstError = results.find((result) => result.error)?.error;
    if (firstError) {
      setPlayerState('failed');
      setPlayerMessage(`Kaynak sirasi buluta yazilamadi: ${firstError.message}`);
      return;
    }

    setPlayerState('idle');
    setPlayerMessage('Kaynak sirasi guncellendi. Izleyiciler ayni sirayi gorur.');
  }

  function reorderSources(fromId: string, toId: string) {
    setSources((prev) => buildReorderedList(prev, fromId, toId));
  }

  function handleDragStart(event: DragEvent<HTMLElement>, sourceId: string) {
    if (!isAdmin || selectedCategoryFilter !== 'all') return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', sourceId);
    setDraggingSourceId(sourceId);
    setDragOverSourceId(sourceId);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, sourceId: string) {
    if (!draggingSourceId || selectedCategoryFilter !== 'all') return;
    event.preventDefault();
    if (dragOverSourceId !== sourceId) {
      // Reorder live while hovering so the user sees exactly where the source will land.
      reorderSources(draggingSourceId, sourceId);
      setDragOverSourceId(sourceId);
    }
  }

  function handleDrop(sourceId: string) {
    if (!draggingSourceId || selectedCategoryFilter !== 'all') return;
    const ordered = buildReorderedList(sources, draggingSourceId, sourceId);
    setSources(ordered);
    setDraggingSourceId(null);
    setDragOverSourceId(null);

    if (storageMode === 'cloud' && !supportsCloudOrdering) {
      setPlayerState('failed');
      setPlayerMessage('Kalici ortak siralama icin sort_order kolonu gerekli. Asagidaki notu uygulayin.');
      return;
    }

    void persistSourceOrder(ordered);
  }

  function handleDragEnd() {
    setDraggingSourceId(null);
    setDragOverSourceId(null);
  }

  async function applyAlphabeticalSort() {
    if (!requireAdmin()) return;
    if (selectedCategoryFilter !== 'all') {
      setPlayerState('failed');
      setPlayerMessage('A-Z siralama icin once kategori filtresini "Tum kategoriler" yap.');
      return;
    }

    const ordered = [...sources].sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
    setSources(ordered);
    setDraggingSourceId(null);
    setDragOverSourceId(null);

    if (storageMode === 'cloud') {
      if (!supportsCloudOrdering) {
        setPlayerState('failed');
        setPlayerMessage('A-Z siralamayi herkes icin kalici yapmak icin sort_order kolonu gerekli.');
        return;
      }

      await persistSourceOrder(ordered);
      return;
    }

    setPlayerState('idle');
    setPlayerMessage('A-Z siralama uygulandi.');
  }

  function switchToSourceByStep(step: 1 | -1) {
    const enabledInActiveCategory = visibleSources.filter((source) => source.enabled);
    if (enabledInActiveCategory.length === 0) {
      setPlayerState('failed');
      setPlayerMessage('Secili kategoride etkin kaynak yok.');
      return;
    }

    const currentIndex = enabledInActiveCategory.findIndex((source) => source.id === activeSourceId);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const target =
      enabledInActiveCategory[(safeIndex + step + enabledInActiveCategory.length) % enabledInActiveCategory.length];
    triedInCycleRef.current = new Set([target.id]);
    setActiveSourceId(target.id);
  }

  function switchToNextSource() {
    switchToSourceByStep(1);
  }

  function switchToPreviousSource() {
    switchToSourceByStep(-1);
  }

  async function toggleSource(id: string) {
    if (!requireAdmin()) return;

    const target = sources.find((source) => source.id === id);
    if (!target) return;
    const nextEnabled = !target.enabled;

    if (storageMode === 'cloud' && supabase) {
      setIsSaving(true);
      const { error } = await supabase
        .from(SUPABASE_TABLE)
        .update({ enabled: nextEnabled })
        .eq('id', id);
      setIsSaving(false);

      if (error) {
        setPlayerState('failed');
        setPlayerMessage(`Kaynak durumu guncellenemedi: ${error.message}`);
        return;
      }
    }

    setSources((prev) =>
      prev.map((source) =>
        source.id === id
          ? {
              ...source,
              enabled: nextEnabled,
            }
          : source,
      ),
    );
  }

  function onIframeLoaded() {
    setPlayerState('ready');
    setPlayerMessage('Yayin aktif. Kaynak engellenirse sonraki kaynaga gecebilirsiniz.');
    if (activeSource) {
      triedInCycleRef.current = new Set([activeSource.id]);
    }
  }

  function onIframeError() {
    setPlayerState('failed');
    setPlayerMessage('Bu kaynak iframe acmiyor olabilir. Sonraki kaynaga gecin.');
  }

  function onVideoCanPlay() {
    const video = videoRef.current;
    if (!video || !activeSource) return;

    const attemptKey = `${activeSource.id}:${activeSource.url}`;
    if (autoPlayAttemptKeyRef.current === attemptKey && !video.paused) {
      setPlayerState('ready');
      return;
    }

    autoPlayAttemptKeyRef.current = attemptKey;

    const tryAutoPlay = async () => {
      try {
        video.muted = false;
        await video.play();
        setPlayerState('ready');
        setPlayerMessage('Yayin otomatik baslatildi. Takilma olursa sonraki kaynagi deneyin.');
        triedInCycleRef.current = new Set([activeSource.id]);
        return;
      } catch {
        try {
          // Most browsers block unmuted autoplay; muted fallback keeps one-click viewing flow.
          video.muted = true;
          await video.play();
          setPlayerState('ready');
          setPlayerMessage('Tarayici sesli autoplayi engelledi. Yayin sessiz baslatildi; sesi playerdan acabilirsiniz.');
          triedInCycleRef.current = new Set([activeSource.id]);
          return;
        } catch {
          setPlayerState('failed');
          setPlayerMessage('Tarayici otomatik oynatmayi engelledi. Oynat tusuna basin veya baska kaynak deneyin.');
        }
      }
    };

    void tryAutoPlay();
  }

  function onVideoError() {
    setPlayerState('failed');
    setPlayerMessage('Bu medya baglantisi oynatilmadi. Linki veya codec destegini kontrol edin.');
  }

  function openSourceInNewTab(source: StreamSource | null) {
    if (!source) return false;
    const popup = window.open(source.url, '_blank', 'noopener,noreferrer');
    if (!popup) {
      setPlayerState('failed');
      setPlayerMessage('Yeni sekme acilamadi. Tarayicida pop-up izni verip tekrar deneyin.');
      return false;
    }

    return true;
  }

  function openActiveSourceInNewTab() {
    void openSourceInNewTab(activeSource);
  }

  async function toggleFullscreen() {
    if (!canViewContent || !activeSource?.enabled) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };

    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    if (fullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
        return;
      }

      if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      }
      return;
    }

    if (playbackMode === 'video' && videoRef.current) {
      const video = videoRef.current as HTMLVideoElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
        webkitEnterFullscreen?: () => void;
      };

      if (video.requestFullscreen) {
        await video.requestFullscreen();
        return;
      }

      if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
        return;
      }

      if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        return;
      }
    }

    if (playbackMode === 'iframe' && iframeRef.current) {
      const iframe = iframeRef.current as HTMLIFrameElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };

      if (iframe.requestFullscreen) {
        await iframe.requestFullscreen();
        return;
      }

      if (iframe.webkitRequestFullscreen) {
        iframe.webkitRequestFullscreen();
        return;
      }
    }

    const container = playerContainerRef.current as (HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    }) | null;

    if (!container) return;

    if (container.requestFullscreen) {
      await container.requestFullscreen();
      return;
    }

    if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
      return;
    }

    setPlayerState('failed');
    setPlayerMessage('Tarayici tam ekran API destegi vermiyor.');
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 lg:h-screen lg:overflow-hidden">
      <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 lg:grid lg:h-full lg:grid-cols-[minmax(340px,430px)_minmax(0,1fr)] lg:gap-6 lg:space-y-0 lg:px-8 lg:py-6">
        <section className="space-y-5 lg:h-full lg:overflow-y-auto lg:pr-2">
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-cyan-300">Yayin Merkezi</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Kaynak Yonetimi ve Hizli Gecis</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Tum kaynaklarini tek panelden yonet. Bir kaynak acilmazsa tek tikla veya otomatik olarak digerine gec.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Depolama: {storageMode === 'cloud' ? 'Bulut (tum cihazlardan ortak liste)' : 'Lokal (sadece bu cihaz)'}
            </p>
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
            {!hasCloudConfigured && (
              <p className="text-xs text-amber-300">
                Supabase baglantisi kapali. VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY olmadan giris acilmaz.
              </p>
            )}
            {hasCloudConfigured && !ADMIN_EMAIL && (
              <p className="text-xs text-amber-300">VITE_ADMIN_EMAIL ayari yok. Env degiskenini tanimlamalisin.</p>
            )}

            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-2">
              <button
                type="button"
                onClick={() => setShowAdminLoginPanel((prev) => !prev)}
                className="flex w-full items-center justify-between text-left text-xs font-medium text-cyan-200"
              >
                <span>Yonetici Girisi</span>
                <span>{showAdminLoginPanel ? 'Kapat' : 'Ac'}</span>
              </button>

              {showAdminLoginPanel && (
                <div className="mt-2 space-y-2">
                  {storageMode === 'cloud' && authUserEmail && isAdmin ? (
                    <div className="space-y-2">
                      <p className="text-xs text-zinc-300">Admin oturumu acik: {authUserEmail}</p>
                      <button
                        type="button"
                        onClick={() => void handleLogout()}
                        className="rounded-md border border-cyan-500/50 px-3 py-2 text-xs text-cyan-100 hover:border-cyan-300"
                      >
                        Cikis Yap
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleAdminLogin} className="space-y-2">
                      <input
                        value={adminAuthEmail}
                        onChange={(event) => setAdminAuthEmail(event.target.value)}
                        placeholder="Yonetici e-posta"
                        disabled={!hasCloudConfigured}
                        className="w-full rounded-md border border-cyan-500/40 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-300 disabled:opacity-60"
                      />
                      <input
                        type={showAdminPassword ? 'text' : 'password'}
                        value={adminAuthPassword}
                        onChange={(event) => setAdminAuthPassword(event.target.value)}
                        placeholder="Sifre"
                        disabled={!hasCloudConfigured}
                        className="w-full rounded-md border border-cyan-500/40 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-300 disabled:opacity-60"
                      />
                      <label className="flex items-center gap-2 text-xs text-cyan-200/80">
                        <input
                          type="checkbox"
                          checked={showAdminPassword}
                          onChange={(event) => setShowAdminPassword(event.target.checked)}
                          className="accent-cyan-400"
                        />
                        Sifreyi goster
                      </label>
                      <button
                        type="submit"
                        disabled={isAdminAuthSubmitting || !ADMIN_EMAIL || !hasCloudConfigured}
                        className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isAdminAuthSubmitting ? 'Giris yapiliyor...' : 'Admin Girisi Yap'}
                      </button>
                    </form>
                  )}
                  {adminAuthMessage && <p className="text-xs text-cyan-100/90">{adminAuthMessage}</p>}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
              <button
                type="button"
                onClick={() => setShowViewerLoginPanel((prev) => !prev)}
                className="flex w-full items-center justify-between text-left text-xs font-medium text-amber-200"
              >
                <span>Izleyici Girisi</span>
                <span>{showViewerLoginPanel ? 'Kapat' : 'Ac'}</span>
              </button>

              {showViewerLoginPanel && (
                <div className="mt-2 space-y-2">
                  {storageMode === 'cloud' && authUserEmail && !isAdmin ? (
                    <div className="space-y-2">
                      <p className="text-xs text-zinc-300">Izleyici oturumu acik: {authUserEmail}</p>
                      <button
                        type="button"
                        onClick={() => void handleLogout()}
                        className="rounded-md border border-amber-500/50 px-3 py-2 text-xs text-amber-100 hover:border-amber-300"
                      >
                        Cikis Yap
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleViewerLogin} className="space-y-2">
                      <input
                        value={viewerAuthEmail}
                        onChange={(event) => setViewerAuthEmail(event.target.value)}
                        placeholder="Izleyici e-posta"
                        disabled={!hasCloudConfigured}
                        className="w-full rounded-md border border-amber-500/40 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-amber-300 disabled:opacity-60"
                      />
                      <input
                        type={showViewerPassword ? 'text' : 'password'}
                        value={viewerAuthPassword}
                        onChange={(event) => setViewerAuthPassword(event.target.value)}
                        placeholder="Sifre"
                        disabled={!hasCloudConfigured}
                        className="w-full rounded-md border border-amber-500/40 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-amber-300 disabled:opacity-60"
                      />
                      <label className="flex items-center gap-2 text-xs text-amber-200/80">
                        <input
                          type="checkbox"
                          checked={showViewerPassword}
                          onChange={(event) => setShowViewerPassword(event.target.checked)}
                          className="accent-amber-400"
                        />
                        Sifreyi goster
                      </label>
                      <button
                        type="submit"
                        disabled={isViewerAuthSubmitting || !hasCloudConfigured}
                        className="rounded-md bg-amber-400 px-3 py-2 text-xs font-medium text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isViewerAuthSubmitting ? 'Giris yapiliyor...' : 'Izleyici Girisi Yap'}
                      </button>
                    </form>
                  )}
                  {viewerAuthMessage && <p className="text-xs text-amber-100/90">{viewerAuthMessage}</p>}
                  {storageMode === 'cloud' && authUserEmail && (
                    <p className={`text-xs ${isAdmin ? 'text-emerald-300' : 'text-amber-300'}`}>
                      Aktif hesap: {authUserEmail} ({isAdmin ? 'Admin' : 'Izleyici'})
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {isAdmin && storageMode === 'cloud' && (
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <h2 className="text-sm font-medium text-zinc-200">Izleme Izinleri</h2>
              <p className="text-xs text-zinc-400">Kullanici olusturup izleme yetkisi verebilir, mevcut izinleri kaldirabilirsin.</p>

              <form onSubmit={createViewerAccount} className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/50 p-3">
                <p className="text-xs text-zinc-300">Yeni izleyici olustur</p>
                <input
                  value={viewerEmailInput}
                  onChange={(event) => setViewerEmailInput(event.target.value)}
                  placeholder="izleyici@ornek.com"
                  disabled={isSavingViewer || isCreatingViewerUser}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
                />
                <input
                  type={showNewViewerPassword ? 'text' : 'password'}
                  value={viewerPasswordInput}
                  onChange={(event) => setViewerPasswordInput(event.target.value)}
                  placeholder="Sifre (min 6 karakter)"
                  disabled={isSavingViewer || isCreatingViewerUser}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
                />
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={showNewViewerPassword}
                    onChange={(event) => setShowNewViewerPassword(event.target.checked)}
                    className="accent-cyan-400"
                  />
                  Sifreyi goster
                </label>
                <button
                  type="submit"
                  disabled={isSavingViewer || isCreatingViewerUser}
                  className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isCreatingViewerUser ? 'Kullanici aciliyor...' : 'Kullanici Ac ve Izin Ver'}
                </button>
              </form>

              <form onSubmit={addViewerEmail} className="space-y-2">
                <p className="text-xs text-zinc-300">Mevcut hesaba sadece izleme izni ver</p>
                <input
                  value={grantViewerEmailInput}
                  onChange={(event) => setGrantViewerEmailInput(event.target.value)}
                  placeholder="izleyici@ornek.com"
                  disabled={isSavingViewer || isCreatingViewerUser}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={isSavingViewer || isCreatingViewerUser}
                  className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSavingViewer ? 'Kaydediliyor...' : 'Sadece Izin Ekle'}
                </button>
              </form>

              <div className="space-y-2 pr-1">
                {isLoadingViewers && <p className="text-xs text-zinc-400">Izin listesi yukleniyor...</p>}
                {!isLoadingViewers && viewerEmails.length === 0 && (
                  <p className="text-xs text-zinc-400">Henuz izinli izleyici yok. Sadece admin erisebilir.</p>
                )}
                {viewerEmails.map((email) => (
                  <div key={email} className="flex items-center justify-between rounded-md border border-zinc-800 px-2 py-1 text-xs">
                    <span className="truncate text-zinc-300">{email}</span>
                    {email === ADMIN_EMAIL ? (
                      <span className="text-emerald-300">Admin</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void removeViewerEmail(email)}
                        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-red-400 hover:text-red-300"
                      >
                        Kaldir
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isAdmin && storageMode === 'cloud' && (
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium text-zinc-200">Giris Gecmisi</h2>
                  <p className="text-xs text-zinc-400">Kim ne zaman giris yapti veya cikis yapti goruntuleyebilirsin.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadAccessLogs()}
                  disabled={isLoadingAccessLogs}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-cyan-400 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Yenile
                </button>
              </div>

              {isLoadingAccessLogs && <p className="text-xs text-zinc-400">Giris kayitlari yukleniyor...</p>}
              {!isLoadingAccessLogs && accessLogsError && <p className="text-xs text-amber-300">{accessLogsError}</p>}
              {!isLoadingAccessLogs && !accessLogsError && accessLogs.length === 0 && (
                <p className="text-xs text-zinc-400">Henuz giris veya cikis kaydi yok.</p>
              )}

              {!accessLogsError && accessLogs.length > 0 && (
                <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                  {accessLogs.map((record) => (
                    <div key={record.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-xs">
                      <p className="truncate text-zinc-200">{record.email}</p>
                      <p className="text-[11px] text-zinc-500">
                        {record.event_type === 'login' ? 'Giris' : 'Cikis'} - {record.role === 'admin' ? 'Admin' : 'Izleyici'} -{' '}
                        {formatDateTime(record.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isAdmin && (
            <form onSubmit={handleAddSource} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <h2 className="text-sm font-medium text-zinc-200">Yeni Kaynak Ekle</h2>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Kaynak adi"
                disabled={isSaving || isLoadingSources}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
              />
              <input
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="https://..."
                disabled={isSaving || isLoadingSources}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
              />
              <p className="text-[11px] text-zinc-500">
                Not: .m3u8 ve .ts medya linkleri dahili oynaticida acilir. HTTPS sitede http:// medya linkleri engellenebilir.
              </p>
              <div className="flex items-center gap-2">
                <label className="text-xs text-zinc-400">Tur:</label>
                <select
                  value={newCategory}
                  onChange={(event) => setNewCategory(event.target.value as SourceCategory)}
                  disabled={isSaving || isLoadingSources}
                  className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="sports">Mac Yayinlari</option>
                  <option value="tv">TV</option>
                  <option value="music">Muzik</option>
                </select>
                <button
                  type="submit"
                  disabled={isSaving || isLoadingSources}
                  className="ml-auto rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSaving ? 'Kaydediliyor...' : 'Ekle'}
                </button>
              </div>
              {!canViewContent && storageMode === 'cloud' && (
                <p className="text-xs text-zinc-500">Yayin listesi icin once izinli e-postayla giris yapmalisin.</p>
              )}
            </form>
          )}

          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
            <button
              type="button"
              onClick={() => setShowIptvTools((prev) => !prev)}
              className="flex w-full items-center justify-between text-left text-sm font-medium text-zinc-200"
            >
              <span>IPTV / M3U Donusturucu</span>
              <span className="text-xs text-zinc-400">{showIptvTools ? 'Kapat' : 'Ac'}</span>
            </button>

            {showIptvTools && (
              <div className="space-y-3">
                <p className="text-xs text-zinc-400">M3U linki veya dosyasi yukleyip TXT (Kanal Adi | URL) olusturabilirsin.</p>

                <form onSubmit={importM3uFromUrl} className="space-y-2">
                  <input
                    value={m3uUrl}
                    onChange={(event) => setM3uUrl(event.target.value)}
                    placeholder="https://ornek.com/list.m3u"
                    disabled={!isAdmin || isImportingM3u || isLoadingSources}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400 disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={!isAdmin || isImportingM3u || isLoadingSources}
                    className="rounded-md border border-cyan-500 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isImportingM3u ? 'URLden cekiliyor...' : 'M3U Linkini Yukle'}
                  </button>
                </form>

                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-400">M3U dosyasi yukle (.m3u, .m3u8, .txt)</label>
                  <input
                    type="file"
                    accept=".m3u,.m3u8,.txt,text/plain,application/x-mpegURL,audio/x-mpegurl"
                    onChange={handleM3uFileUpload}
                    disabled={!isAdmin || isImportingM3u || isLoadingSources}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-cyan-500 file:px-2 file:py-1 file:text-xs file:font-medium file:text-zinc-950 disabled:opacity-60"
                  />
                  {m3uFileName && <p className="text-[11px] text-zinc-500">Yuklenen kaynak: {m3uFileName}</p>}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={prepareTxtFromLoadedM3u}
                    disabled={!isAdmin || isImportingM3u || isLoadingSources}
                    className="rounded-md bg-amber-400 px-3 py-2 text-xs font-medium text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    TXT Goruntule
                  </button>
                  <button
                    type="button"
                    onClick={downloadPreparedTxt}
                    disabled={!isAdmin || isImportingM3u || isLoadingSources || !txtPreviewContent.trim()}
                    className="rounded-md border border-amber-400 px-3 py-2 text-xs font-medium text-amber-300 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    TXT Indir
                  </button>
                  <button
                    type="button"
                    onClick={importM3uFromText}
                    disabled={!isAdmin || isImportingM3u || isLoadingSources || !m3uText.trim()}
                    className="rounded-md border border-cyan-500 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Kaynaklara Ekle
                  </button>
                </div>

                {parsedM3uChannels.length > 0 && (
                  <p className="text-xs text-zinc-400">Algilanan kanal sayisi: {parsedM3uChannels.length}</p>
                )}

                {showTxtPreview && txtPreviewContent && (
                  <textarea
                    readOnly
                    value={txtPreviewContent}
                    rows={8}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none"
                  />
                )}

                <p className="text-[11px] text-zinc-500">
                  Not: URLden cekme CORS nedeniyle engellenirse dosya yukleme en garanti yontemdir.
                </p>
                {iptvMessage && (
                  <p
                    className={`text-xs ${
                      iptvMessageType === 'error'
                        ? 'text-red-300'
                        : iptvMessageType === 'success'
                          ? 'text-emerald-300'
                          : 'text-zinc-300'
                    }`}
                  >
                    {iptvMessage}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
            <button
              type="button"
              onClick={() => setShowSourceList((prev) => !prev)}
              className="flex w-full items-center justify-between text-left text-sm font-medium text-zinc-200"
            >
              <span>Kaynak Listesi ({accessibleSources.length})</span>
              <span className="text-xs text-zinc-400">{showSourceList ? 'Kapat' : 'Ac'}</span>
            </button>

            {showSourceList && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-zinc-500">
                    Kaynak sayisinda limit yok. Istedigin kadar kaynak ekleyebilir, surukle-birak ile sirayi degistirebilirsin.
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setIsTvMode((prev) => {
                          const next = !prev;
                          if (next) {
                            setShowSourceList(true);
                            setTvFocusArea('categories');
                          }
                          return next;
                        });
                      }}
                      className={`rounded-md border px-2 py-1 text-xs transition ${
                        isTvMode
                          ? 'border-emerald-400 text-emerald-300 hover:border-emerald-300'
                          : 'border-zinc-700 text-zinc-200 hover:border-zinc-500'
                      }`}
                    >
                      TV Modu: {isTvMode ? 'Acik' : 'Kapali'}
                    </button>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => void applyAlphabeticalSort()}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition hover:border-zinc-500"
                      >
                        A-Z Sirala (Kalici)
                      </button>
                    )}
                    {isTvMode ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                        <span>Kategori:</span>
                        {tvCategoryOptions.map((option, index) => {
                          const isSelected = selectedCategoryFilter === option.value;
                          const isTvFocused = tvFocusArea === 'categories' && tvCategoryIndex === index;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setSelectedCategoryFilter(option.value);
                                setTvCategoryIndex(index);
                                setTvFocusArea('categories');
                              }}
                              className={`rounded-md border px-2 py-1 text-xs transition ${
                                isSelected
                                  ? 'border-cyan-400 bg-cyan-400/10 text-cyan-200'
                                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                              } ${isTvFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900' : ''}`}
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-zinc-300">
                        <span>Kategori:</span>
                        <select
                          value={selectedCategoryFilter}
                          onChange={(event) => setSelectedCategoryFilter(event.target.value as 'all' | SourceCategory)}
                          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                        >
                          <option value="all">Tum kategoriler</option>
                          <option value="sports">Mac Yayinlari</option>
                          <option value="tv">TV</option>
                          {isAdmin && <option value="music">Muzik</option>}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
                {isTvMode && (
                  <p className="text-xs text-emerald-300">
                    TV modu aktif: Sol/Sag ile kategori ve oynatici kontrollerini sec, Yukari/Asagi ile bolum degistir,
                    Enter ile uygula.
                  </p>
                )}
                {isAdmin && selectedCategoryFilter !== 'all' && (
                  <p className="text-xs text-amber-300">Siralama yapmak icin kategori filtresini "Tum kategoriler" yap.</p>
                )}
                {isAdmin && storageMode === 'cloud' && !supportsCloudOrdering && (
                  <p className="text-xs text-amber-300">
                    Tum izleyicilerde ayni siralama icin stream_sources tablosuna sort_order kolonu ekleyin.
                  </p>
                )}

                <div className="space-y-2 pr-1">
                  {isLoadingSources && <p className="text-sm text-zinc-400">Kaynaklar yukleniyor...</p>}
                  {!canViewContent && !isLoadingSources && (
                    <p className="text-sm text-zinc-400">Kaynaklari listelemek icin once giris yapmalisin.</p>
                  )}

                  {canViewContent &&
                    visibleSources.map((source, index) => {
                const isActive = source.id === activeSourceId;
                 const isDragging = draggingSourceId === source.id;
                 const isDragOver = dragOverSourceId === source.id;
                  const isFocused = focusedSourceId === source.id;
                  const sourceOrder = index + 1;
                return (
                  <article
                    key={source.id}
                    ref={(node) => {
                      sourceItemRefs.current[source.id] = node;
                    }}
                     onClick={() => {
                       selectSource(source.id);
                       if (isTvMode) {
                         setFocusedSourceId(source.id);
                         setTvFocusArea('sources');
                       }
                     }}
                      onMouseEnter={() => {
                        if (isTvMode && source.enabled) {
                          setFocusedSourceId(source.id);
                           setTvFocusArea('sources');
                        }
                      }}
                      onDragOver={(event) => handleDragOver(event, source.id)}
                      onDrop={() => handleDrop(source.id)}
                    className={`rounded-lg border p-3 transition ${
                      isActive ? 'border-cyan-400 bg-zinc-950' : 'border-zinc-800 bg-zinc-950/60'
                       } ${isDragOver ? 'border-cyan-300 bg-cyan-400/5' : ''} ${isDragging ? 'opacity-60' : ''} ${
                         isTvMode ? 'p-4' : ''
                       } ${isTvMode && isFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-950' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-left">
                          <p className={`font-medium ${isTvMode ? 'text-base' : 'text-sm'}`}>
                            <span className="mr-2 text-zinc-400">{sourceOrder}.</span>
                            {source.name}
                          </p>
                        <p className="text-xs text-zinc-400">{categoryLabel(source.category)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isAdmin && selectedCategoryFilter === 'all' && (
                          <button
                            type="button"
                            draggable
                            onDragStart={(event) => handleDragStart(event, source.id)}
                            onDragEnd={handleDragEnd}
                            onClick={(event) => event.stopPropagation()}
                            className="cursor-grab rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 active:cursor-grabbing"
                            title="Siralamak icin surukle"
                          >
                            Surukle
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              startEditing(source);
                            }}
                            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-cyan-400 hover:text-cyan-300"
                          >
                            Duzenle
                          </button>
                        )}
                        <label className="text-xs text-zinc-400">
                          <input
                            type="checkbox"
                            checked={source.enabled}
                            disabled={!isAdmin}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => void toggleSource(source.id)}
                            className="mr-1"
                          />
                          Aktif
                        </label>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void removeSource(source.id);
                            }}
                            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-red-400 hover:text-red-300"
                          >
                            Sil
                          </button>
                        )}
                      </div>
                    </div>

                    {isAdmin && editingId === source.id && (
                      <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3" onClick={(event) => event.stopPropagation()}>
                        <input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          placeholder="Kaynak adi"
                          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400"
                        />
                        <input
                          value={editUrl}
                          onChange={(event) => setEditUrl(event.target.value)}
                          placeholder="https://..."
                          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none transition focus:border-cyan-400"
                        />
                        <div className="flex items-center gap-2">
                          <select
                            value={editCategory}
                            onChange={(event) => setEditCategory(event.target.value as SourceCategory)}
                            className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                          >
                            <option value="sports">Mac Yayinlari</option>
                            <option value="tv">TV</option>
                            <option value="music">Muzik</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => void saveSourceChanges(source.id)}
                            className="ml-auto rounded-md bg-cyan-500 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-cyan-400"
                          >
                            Kaydet
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditing}
                            className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-500"
                          >
                            Iptal
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
                    })}

                  {canViewContent && !isLoadingSources && visibleSources.length === 0 && (
                    <p className="text-sm text-zinc-400">Bu filtrede kaynak yok.</p>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        <section className="space-y-5 lg:sticky lg:top-0 lg:self-start">
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70">
            <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3">
              <p className="text-sm text-zinc-300">
                Aktif Kaynak: <span className="font-medium text-white">{activeSource?.name ?? 'Secilmedi'}</span>
              </p>
              <p className="text-xs text-zinc-500">Mod: {playbackMode === 'video' ? 'Dahili Oynatici' : 'Iframe'}</p>
              <p className="text-xs text-zinc-500">Cozunurluk: {videoResolution}</p>
              <p className="text-xs text-zinc-500">FPS: {videoFps}</p>
              <div className="ml-auto flex items-center gap-2">
                {tvPlayerControls.map((control, index) => {
                  const isTvFocused = isTvMode && tvFocusArea === 'playerControls' && tvPlayerControlIndex === index;

                  if (control.key === 'toggleAutoSwitch') {
                    return (
                      <button
                        key={control.key}
                        type="button"
                        onClick={() => {
                          setAutoSwitch((prev) => !prev);
                          if (isTvMode) {
                            setTvPlayerControlIndex(index);
                            setTvFocusArea('playerControls');
                          }
                        }}
                        className={`rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 ${
                          isTvFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900' : ''
                        }`}
                      >
                        {control.label}
                      </button>
                    );
                  }

                  if (control.key === 'previousSource') {
                    return (
                      <button
                        key={control.key}
                        type="button"
                        onClick={() => {
                          switchToPreviousSource();
                          if (isTvMode) {
                            setTvPlayerControlIndex(index);
                            setTvFocusArea('playerControls');
                          }
                        }}
                        className={`rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 ${
                          isTvFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900' : ''
                        }`}
                      >
                        {control.label}
                      </button>
                    );
                  }

                  if (control.key === 'nextSource') {
                    return (
                      <button
                        key={control.key}
                        type="button"
                        onClick={() => {
                          switchToNextSource();
                          if (isTvMode) {
                            setTvPlayerControlIndex(index);
                            setTvFocusArea('playerControls');
                          }
                        }}
                        className={`rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 ${
                          isTvFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900' : ''
                        }`}
                      >
                        {control.label}
                      </button>
                    );
                  }

                  return (
                    <button
                      key={control.key}
                      type="button"
                      onClick={() => {
                        void toggleFullscreen();
                        if (isTvMode) {
                          setTvPlayerControlIndex(index);
                          setTvFocusArea('playerControls');
                        }
                      }}
                      disabled={!activeSource || !canViewContent}
                      className={`rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 ${
                        isTvFocused ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-900' : ''
                      }`}
                    >
                      {control.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setAutoOpenInNewTabOnFail((prev) => !prev)}
                  className="rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500"
                >
                  Acilmazsa Yeni Sekme: {autoOpenInNewTabOnFail ? 'Acik' : 'Kapali'}
                </button>
                <button
                  type="button"
                  onClick={openActiveSourceInNewTab}
                  disabled={!activeSource}
                  className="rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Yeni Sekmede Ac
                </button>
              </div>
            </div>

             <div ref={playerContainerRef} className="aspect-video w-full bg-black">
               {!canViewContent ? (
                 <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-400">
                   Yayinlari gormek icin izinli e-posta ile giris yapmalisin.
                 </div>
               ) : activeSource?.enabled ? (
                 playbackMode === 'video' ? (
                   <video
                     key={`${activeSource.id}-${activeSource.url}`}
                     ref={videoRef}
                     className="h-full w-full"
                     controls
                     autoPlay
                     playsInline
                     onCanPlay={onVideoCanPlay}
                     onError={onVideoError}
                   />
                 ) : (
                   <iframe
                     key={iframeKey}
                      ref={iframeRef}
                     src={activeSource.url}
                     title="Canli Yayin"
                     className="h-full w-full"
                     allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                     allowFullScreen
                     onLoad={onIframeLoaded}
                     onError={onIframeError}
                   />
                 )
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  Aktif kaynak yok. Listeden bir kaynak secin.
                </div>
              )}
            </div>

            {canViewContent && playerState === 'failed' && activeSource && (
              <div className="border-t border-zinc-800 bg-zinc-950/70 px-4 py-3">
                <p className="text-xs text-zinc-300">
                  Bu kaynak iframe icinde engellenmis olabilir. Dogrudan kaynak sayfasini yeni sekmede acabilirsin.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={openActiveSourceInNewTab}
                    className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 transition hover:bg-white"
                  >
                    Kaynagi Yeni Sekmede Ac
                  </button>
                  <button
                    type="button"
                    onClick={switchToPreviousSource}
                    className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-500"
                  >
                    Onceki Kaynaga Gec
                  </button>
                  <button
                    type="button"
                    onClick={switchToNextSource}
                    className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-500"
                  >
                    Sonraki Kaynaga Gec
                  </button>
                </div>
              </div>
            )}

            <div className="border-t border-zinc-800 px-4 py-3">
              <p
                className={`text-sm ${
                  playerState === 'failed'
                    ? 'text-red-300'
                    : playerState === 'ready'
                      ? 'text-emerald-300'
                      : 'text-zinc-300'
                }`}
              >
                {playerMessage}
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}