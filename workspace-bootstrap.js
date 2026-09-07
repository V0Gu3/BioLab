(function (root) {
  'use strict';
  try {
    const access = JSON.parse(root.localStorage.getItem('nexo-access-v1') || 'null');
    const current = access?.currentUserId;
    root.__BIO_WORKSPACE_MODE__ = access?.workspace?.modes?.[current] === 'training' ? 'training' : 'operational';
    root.__BIO_TRAINING__ = root.__BIO_WORKSPACE_MODE__ === 'training';
  } catch { root.__BIO_WORKSPACE_MODE__ = 'operational'; root.__BIO_TRAINING__ = false; }
})(window);
