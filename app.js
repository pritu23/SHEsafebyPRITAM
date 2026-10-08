/**
 * SHESAFE - Advanced Client-side Logic & Emergency Safety Suite
 * Features: Audio Engine (Web Audio API), Geolocation, Contacts Manager,
 * Fake Call Simulator, Ambient Audio Evidence Recorder, Walk Timer, Stealth Mode.
 */

(function () {
  'use strict';

  // State Management
  const state = {
    currentUser: null,
    isAlarmActive: false,
    audioCtx: null,
    sirenOscillator: null,
    sirenGain: null,
    sirenInterval: null,
    ringtoneInterval: null,
    currentCoords: null,
    watchId: null,
    walkTimerInterval: null,
    walkTimeRemaining: 0,
    mediaRecorder: null,
    recordedChunks: [],
    isRecording: false,
    contacts: [], // No hard-coded demo contacts
    fakeCallTimeout: null,
    strobeActive: false,
    currentGroup: null,
    groupMembers: [],
    groupListenerUnsub: null,
    membersListenerUnsub: null,
    groupSosListenerUnsub: null,
    groupMessagesListenerUnsub: null,
    userDocListenerUnsub: null,
    revealedActivePassword: null,
    isPasswordRevealed: false,
    currentGroupSos: null,
    groupMessages: [],
    locationWatchId: null,
    lastLocationWriteTime: 0,
    isSilencedRemoteSiren: false,
    acknowledgedAlertId: null,
    autoExpireTimer: null,
    activeRemoteAlert: null,
    activeSosMsgId: null,
  };

  /* --------------------------------------------------------------------------
     1. INITIALIZATION & FIREBASE AUTHENTICATION
     -------------------------------------------------------------------------- */
  function initApp() {
    handleOpeningSplash();
    initTheme();
    requestLocationUpdate();
    setupEventListeners();
    initFirebaseAuth();
  }

  function handleOpeningSplash() {
    const splash = document.getElementById('introSplashScreen');
    if (!splash) return;

    function dismissSplash() {
      if (splash.classList.contains('fade-out')) return;
      splash.classList.add('fade-out');
      setTimeout(() => {
        try { splash.remove(); } catch (e) {}
      }, 550);
    }

    // Allow user to click anywhere to skip immediately
    splash.addEventListener('click', dismissSplash);

    // Automatically dismiss after exactly 2 seconds (2000ms)
    setTimeout(dismissSplash, 2000);
  }

  function initFirebaseAuth() {
    if (!window.__IS_FIREBASE_CONFIGURED__) {
      showAuthAlert(
        '⚠️ Firebase Credentials Needed: Please provide your Firebase project credentials in firebase-config.js (or via environment variables) for web app "SheSafeWebsite".',
        'error'
      );
      return;
    }

    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged((user) => {
        handleAuthStateChanged(user);
      });
    } else {
      console.warn('Firebase Auth SDK not detected. Please verify network access to Firebase CDN.');
      showAuthAlert('Firebase Auth is initializing. If you are offline, please check your network connection.', 'error');
    }
  }

  function handleAuthStateChanged(user) {
    const authSection = document.getElementById('authSection');
    const mainDashboard = document.getElementById('mainDashboard');
    const mainNavLinks = document.getElementById('mainNavLinks');
    const mainFooter = document.getElementById('mainFooter');
    const userProfileNav = document.getElementById('userProfileNav');
    const userEmailNav = document.getElementById('userEmailNav');
    const userAvatarText = document.getElementById('userAvatarText');

    if (user) {
      // Authenticated User -> Reveal Dashboard directly
      state.currentUser = user;
      if (authSection) authSection.style.display = 'none';
      if (mainDashboard) mainDashboard.style.display = 'block';
      if (mainNavLinks) mainNavLinks.style.display = 'flex';
      if (mainFooter) mainFooter.style.display = 'block';
      if (userProfileNav) userProfileNav.style.display = 'inline-flex';

      const displayName = user.displayName || user.email || 'User';
      if (userEmailNav) userEmailNav.textContent = displayName;
      if (userAvatarText) userAvatarText.textContent = displayName.charAt(0).toUpperCase();

      loadContacts();
      syncUserSafetyGroup();
      showToast(`Welcome, ${displayName}! SheSafe shield is active.`, 'success');
    } else {
      // Unauthenticated User -> Present Login & Sign Up screen
      state.currentUser = null;
      state.contacts = [];
      cleanupGroupSubscriptions();
      state.currentGroup = null;
      state.groupMembers = [];
      state.revealedActivePassword = null;
      state.isPasswordRevealed = false;

      if (authSection) authSection.style.display = 'flex';
      if (mainDashboard) mainDashboard.style.display = 'none';
      if (mainNavLinks) mainNavLinks.style.display = 'none';
      if (mainFooter) mainFooter.style.display = 'none';
      if (userProfileNav) userProfileNav.style.display = 'none';

      renderContactsList();
      renderSafetyGroupUI();
    }
  }

  function getContactsStorageKey() {
    if (state.currentUser && state.currentUser.uid) {
      return `shesafe_contacts_${state.currentUser.uid}`;
    }
    return null;
  }

  // Cloud Firestore Sync (Compliant with Production Rules: match /users/{userId}/{document=**})
  function getFirestoreContactsRef() {
    if (typeof firebase === 'undefined' || !firebase.firestore || !window.__IS_FIREBASE_CONFIGURED__ || !state.currentUser) {
      return null;
    }
    try {
      return firebase.firestore().collection('users').doc(state.currentUser.uid).collection('contacts');
    } catch (e) {
      console.warn('Firestore initialization notice:', e.message);
      return null;
    }
  }

  async function loadContacts() {
    if (!state.currentUser) {
      state.contacts = [];
      renderContactsList();
      return;
    }

    const localKey = getContactsStorageKey();
    if (localKey) {
      try {
        const saved = localStorage.getItem(localKey);
        state.contacts = saved ? JSON.parse(saved) : [];
      } catch (e) {
        state.contacts = [];
      }
    }
    renderContactsList();

    // Pull from Cloud Firestore if online
    const firestoreRef = getFirestoreContactsRef();
    if (firestoreRef) {
      try {
        const snapshot = await firestoreRef.get();
        if (!snapshot.empty) {
          const list = [];
          snapshot.forEach((doc) => {
            list.push({ id: doc.id, ...doc.data() });
          });
          state.contacts = list;
          if (localKey) localStorage.setItem(localKey, JSON.stringify(list));
          renderContactsList();
        }
      } catch (err) {
        console.warn('Firestore fetch notice (cached offline contacts used):', err.message);
      }
    }
  }

  function saveContacts() {
    const key = getContactsStorageKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(state.contacts));
  }

  /* --------------------------------------------------------------------------
     FIREBASE AUTH METHODS (LOGIN, SIGN UP, SIGN OUT, PASSWORD RESET)
     -------------------------------------------------------------------------- */
  function switchAuthTab(targetTab) {
    const loginBtn = document.getElementById('tabLoginBtn');
    const signupBtn = document.getElementById('tabSignupBtn');
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');

    clearAuthAlert();

    if (targetTab === 'login') {
      if (loginBtn) { loginBtn.classList.add('active'); loginBtn.setAttribute('aria-selected', 'true'); }
      if (signupBtn) { signupBtn.classList.remove('active'); signupBtn.setAttribute('aria-selected', 'false'); }
      if (loginForm) loginForm.style.display = 'flex';
      if (signupForm) signupForm.style.display = 'none';
    } else {
      if (loginBtn) { loginBtn.classList.remove('active'); loginBtn.setAttribute('aria-selected', 'false'); }
      if (signupBtn) { signupBtn.classList.add('active'); signupBtn.setAttribute('aria-selected', 'true'); }
      if (loginForm) loginForm.style.display = 'none';
      if (signupForm) signupForm.style.display = 'flex';
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!window.__IS_FIREBASE_CONFIGURED__) {
      showAuthAlert(
        '⚠️ Firebase Credentials Required: Please update firebase-config.js with your project credentials (apiKey, authDomain, projectId) from the Firebase Console for "SheSafeWebsite".',
        'error'
      );
      return;
    }

    if (!email || !password) {
      showAuthAlert('Please enter both email and password.', 'error');
      return;
    }

    setAuthLoading('login', true);
    clearAuthAlert();

    try {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase Authentication is not loaded.');
      }
      await firebase.auth().signInWithEmailAndPassword(email, password);
      // onAuthStateChanged automatically handles dashboard reveal!
    } catch (error) {
      showAuthAlert(getFirebaseErrorMessage(error), 'error');
    } finally {
      setAuthLoading('login', false);
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirm = document.getElementById('signupConfirmPassword').value;

    if (!window.__IS_FIREBASE_CONFIGURED__) {
      showAuthAlert(
        '⚠️ Firebase Credentials Required: Please update firebase-config.js with your project credentials (apiKey, authDomain, projectId) from the Firebase Console for "SheSafeWebsite".',
        'error'
      );
      return;
    }

    if (!email || !password) {
      showAuthAlert('Please fill in all required fields.', 'error');
      return;
    }

    if (password !== confirm) {
      showAuthAlert('Passwords do not match. Please re-enter matching passwords.', 'error');
      return;
    }

    if (password.length < 6) {
      showAuthAlert('Password must be at least 6 characters long.', 'error');
      return;
    }

    setAuthLoading('signup', true);
    clearAuthAlert();

    try {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase Authentication is not loaded.');
      }
      const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      if (cred.user && name) {
        await cred.user.updateProfile({ displayName: name });
      }
      showToast('Account created successfully! Welcome to SheSafe.', 'success');
      // onAuthStateChanged automatically reveals dashboard!
    } catch (error) {
      showAuthAlert(getFirebaseErrorMessage(error), 'error');
    } finally {
      setAuthLoading('signup', false);
    }
  }

  async function handleSignOut() {
    try {
      if (typeof firebase !== 'undefined' && firebase.auth) {
        await firebase.auth().signOut();
      }
      showToast('You have signed out safely.', 'info');
    } catch (error) {
      showToast('Error signing out: ' + error.message, 'error');
    }
  }

  async function handleForgotPassword() {
    if (!window.__IS_FIREBASE_CONFIGURED__) {
      showAuthAlert(
        '⚠️ Firebase Credentials Required: Please update firebase-config.js with your project credentials.',
        'error'
      );
      return;
    }
    const emailInput = document.getElementById('loginEmail');
    const email = emailInput ? emailInput.value.trim() : '';

    if (!email) {
      showAuthAlert('Please enter your email address in the field above to receive a password reset link.', 'error');
      if (emailInput) emailInput.focus();
      return;
    }

    try {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase Authentication is not loaded.');
      }
      await firebase.auth().sendPasswordResetEmail(email);
      showAuthAlert(`Password reset link sent to ${email}! Check your inbox.`, 'success');
    } catch (error) {
      showAuthAlert(getFirebaseErrorMessage(error), 'error');
    }
  }

  function setAuthLoading(formType, isLoading) {
    const submitBtn = document.getElementById(formType === 'login' ? 'loginSubmitBtn' : 'signupSubmitBtn');
    if (!submitBtn) return;

    const textEl = submitBtn.querySelector('.btn-text');
    const spinEl = submitBtn.querySelector('.btn-spinner');

    submitBtn.disabled = isLoading;
    if (textEl) textEl.style.display = isLoading ? 'none' : 'inline';
    if (spinEl) spinEl.style.display = isLoading ? 'inline' : 'none';
  }

  function showAuthAlert(message, type) {
    const alertBox = document.getElementById('authAlertBox');
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `auth-alert ${type === 'error' ? 'auth-alert-error' : 'auth-alert-success'}`;
    alertBox.style.display = 'block';
  }

  function clearAuthAlert() {
    const alertBox = document.getElementById('authAlertBox');
    if (!alertBox) return;
    alertBox.textContent = '';
    alertBox.style.display = 'none';
  }

  function getFirebaseErrorMessage(error) {
    const code = error.code || '';
    switch (code) {
      case 'auth/invalid-email':
        return 'Please enter a valid email address.';
      case 'auth/user-disabled':
        return 'This account has been disabled. Please contact support.';
      case 'auth/api-key-not-valid':
      case 'auth/invalid-api-key':
        return 'Firebase API Key is not yet configured or invalid. Please check your credentials in firebase-config.js.';
      case 'auth/configuration-not-found':
      case 'auth/operation-not-allowed':
        return 'Email/Password provider is not enabled. Please enable "Email/Password" in Firebase Console > Authentication > Sign-in method.';
      case 'auth/user-not-found':
      case 'auth/invalid-credential':
        return 'Invalid email or password. Please verify your credentials or create an account.';
      case 'auth/wrong-password':
        return 'Incorrect password. Please try again or click Forgot Password.';
      case 'auth/email-already-in-use':
        return 'An account already exists with this email address. Please sign in instead.';
      case 'auth/weak-password':
        return 'Password is too weak. Please use at least 6 characters.';
      case 'auth/network-request-failed':
        return 'Network connection error. Please check your internet connectivity.';
      case 'auth/too-many-requests':
        return 'Access to this account has been temporarily blocked due to too many failed attempts. Try again later or reset your password.';
      default:
        return error.message || 'An authentication error occurred. Please try again.';
    }
  }

  function togglePasswordVisibility(button) {
    const targetId = button.getAttribute('data-target');
    const input = document.getElementById(targetId);
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
      button.textContent = '🙈';
    } else {
      input.type = 'password';
      button.textContent = '👁️';
    }
  }

  /* --------------------------------------------------------------------------
     2. AUDIO ENGINE (WEB AUDIO API - ZERO EXTERNAL ASSET DEPENDENCIES)
     -------------------------------------------------------------------------- */
  function getAudioContext() {
    if (!state.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        state.audioCtx = new AudioCtx();
      }
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
    return state.audioCtx;
  }

  // Piercing High-Decibel Siren Sound
  function startSirenSound() {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (state.sirenOscillator) {
      stopSirenSound();
    }

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      gain.gain.setValueAtTime(0.85, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      let high = false;
      osc.frequency.setValueAtTime(750, ctx.currentTime);

      state.sirenInterval = setInterval(() => {
        if (!state.audioCtx) return;
        const now = state.audioCtx.currentTime;
        const targetFreq = high ? 650 : 980;
        osc.frequency.exponentialRampToValueAtTime(targetFreq, now + 0.28);
        high = !high;
      }, 300);

      state.sirenOscillator = osc;
      state.sirenGain = gain;
    } catch (err) {
      console.error('Audio siren error:', err);
    }
  }

  function stopSirenSound() {
    if (state.sirenInterval) {
      clearInterval(state.sirenInterval);
      state.sirenInterval = null;
    }
    if (state.sirenOscillator) {
      try {
        state.sirenOscillator.stop();
        state.sirenOscillator.disconnect();
      } catch (e) {}
      state.sirenOscillator = null;
    }
  }

  // Realistic Phone Ringtone Generator for Fake Incoming Call
  function startRingtoneSound() {
    const ctx = getAudioContext();
    if (!ctx) return;

    stopRingtoneSound();

    function playBeepTone() {
      if (!ctx || ctx.state === 'closed') return;
      try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(440, ctx.currentTime); // Standard phone ring mix (440Hz + 480Hz)
        osc2.frequency.setValueAtTime(480, ctx.currentTime);

        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start();
        osc2.start();
        osc1.stop(ctx.currentTime + 1.8);
        osc2.stop(ctx.currentTime + 1.8);
      } catch (e) {}
    }

    playBeepTone();
    state.ringtoneInterval = setInterval(playBeepTone, 3200);
  }

  function stopRingtoneSound() {
    if (state.ringtoneInterval) {
      clearInterval(state.ringtoneInterval);
      state.ringtoneInterval = null;
    }
  }

  /* --------------------------------------------------------------------------
     3. GEOLOCATION & LIVE GPS SHARING
     -------------------------------------------------------------------------- */
  function requestLocationUpdate() {
    const locStatus = document.getElementById('locationStatusText');
    const locCoords = document.getElementById('locationCoordsText');

    if (!navigator.geolocation) {
      if (locStatus) locStatus.textContent = 'GPS Not Supported';
      showToast('Geolocation is not supported by your browser', 'error');
      return;
    }

    if (locStatus) locStatus.textContent = 'Locating GPS...';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.currentCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: Date.now()
        };
        if (locStatus) locStatus.textContent = 'GPS Locked & Active';
        if (locCoords) locCoords.textContent = `${state.currentCoords.lat.toFixed(4)}, ${state.currentCoords.lng.toFixed(4)} (±${state.currentCoords.accuracy}m)`;
      },
      (err) => {
        console.warn('Geolocation notice:', err.message);
        if (locStatus) locStatus.textContent = 'Location Permission Needed';
        if (locCoords) locCoords.textContent = 'Click to enable live GPS';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function startLiveLocationTracking() {
    if (!navigator.geolocation) return;

    if (state.locationWatchId !== null) {
      navigator.geolocation.clearWatch(state.locationWatchId);
      state.locationWatchId = null;
    }

    state.locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.currentCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: Date.now()
        };

        const locStatus = document.getElementById('locationStatusText');
        const locCoords = document.getElementById('locationCoordsText');
        if (locStatus) locStatus.textContent = '📍 Live GPS Active';
        if (locCoords) locCoords.textContent = `${state.currentCoords.lat.toFixed(4)}, ${state.currentCoords.lng.toFixed(4)} (±${state.currentCoords.accuracy}m)`;

        // Throttled Firestore update while SOS is active (at least once every 10s)
        if (state.isAlarmActive && state.currentGroup) {
          const now = Date.now();
          if (now - state.lastLocationWriteTime > 10000) {
            updateSosLocationInFirestore(pos.coords);
          }
        }
      },
      (err) => {
        console.warn('Live tracking notice:', err.message);
        const locStatus = document.getElementById('locationStatusText');
        if (locStatus) locStatus.textContent = '⚠️ GPS Signal Unavailable';
        if (state.isAlarmActive && state.currentGroup) {
          updateSosLocationUnavailableInFirestore(err.message);
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  function stopLiveLocationTracking() {
    if (state.locationWatchId !== null) {
      navigator.geolocation.clearWatch(state.locationWatchId);
      state.locationWatchId = null;
    }
  }

  async function updateSosLocationInFirestore(coords) {
    if (!state.isAlarmActive || !state.currentGroup || !state.currentUser) return;
    const db = firebase.firestore();
    const groupId = state.currentGroup.id;
    const sosRef = db.collection('groups').doc(groupId).collection('sos').doc(state.currentUser.uid);

    try {
      await sosRef.update({
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        'location.lat': coords.latitude,
        'location.lng': coords.longitude,
        'location.accuracy': Math.round(coords.accuracy),
        'location.timestamp': firebase.firestore.FieldValue.serverTimestamp(),
        'location.mapsUrl': `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`,
        'location.isAvailable': true
      });
      state.lastLocationWriteTime = Date.now();

      if (state.activeSosMsgId) {
        const msgRef = db.collection('groups').doc(groupId).collection('messages').doc(state.activeSosMsgId);
        await msgRef.update({
          location: {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: Math.round(coords.accuracy),
            mapsUrl: `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('Could not update live SOS location:', e.message);
    }
  }

  async function updateSosLocationUnavailableInFirestore(errMsg) {
    if (!state.isAlarmActive || !state.currentGroup || !state.currentUser) return;
    const db = firebase.firestore();
    const sosRef = db.collection('groups').doc(state.currentGroup.id).collection('sos').doc(state.currentUser.uid);

    try {
      await sosRef.update({
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        'location.isAvailable': false,
        'location.error': errMsg || 'Location unavailable'
      });
    } catch (e) {}
  }

  function getMapsUrl() {
    if (state.currentCoords) {
      return `https://www.google.com/maps?q=${state.currentCoords.lat},${state.currentCoords.lng}`;
    }
    return `https://www.google.com/maps`;
  }

  function createEmergencyMessage() {
    const mapsLink = getMapsUrl();
    const timeStr = new Date().toLocaleTimeString();
    return encodeURIComponent(
      `🚨 EMERGENCY ALERT FROM SHESAFE 🚨\nI need immediate help! This is an urgent SOS alert triggered at ${timeStr}.\nMy live location: ${mapsLink}\nPlease reach out or contact the police (112) immediately!`
    );
  }

  /* --------------------------------------------------------------------------
     4. SOS EMERGENCY TRIGGER ENGINE
     -------------------------------------------------------------------------- */
  let sosCountdown = 3;
  let countdownTimer = null;

  function triggerSOSFlow() {
    if (state.isAlarmActive) {
      deactivateEmergencyMode(false);
      return;
    }

    const modal = document.getElementById('sosCountdownModal');
    const countdownEl = document.getElementById('sosCountdownNumber');
    sosCountdown = 3;
    if (countdownEl) countdownEl.textContent = sosCountdown;
    modal.classList.add('open');

    countdownTimer = setInterval(() => {
      sosCountdown--;
      if (countdownEl) countdownEl.textContent = sosCountdown;

      if (sosCountdown <= 0) {
        clearInterval(countdownTimer);
        modal.classList.remove('open');
        activateFullEmergencyMode();
      }
    }, 1000);
  }

  function cancelSOSCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    const modal = document.getElementById('sosCountdownModal');
    modal.classList.remove('open');
    showToast('SOS trigger cancelled safely', 'success');
  }

  async function activateFullEmergencyMode() {
    if (state.isAlarmActive) return;
    state.isAlarmActive = true;

    // 1. Play siren sound
    startSirenSound();

    // 2. Activate strobe light flashing
    startStrobeOverlay();

    // 3. Update SOS button UI to show Stop
    updateHeroSosButton(true);

    // 4. Start live location tracking
    requestLocationUpdate();
    startLiveLocationTracking();

    // 5. Broadcast to Safety Group via Cloud Firestore
    if (state.currentGroup && state.currentUser) {
      broadcastSosToFirestore(true);

      // Auto-expire SOS after 2 hours (7,200,000 ms)
      if (state.autoExpireTimer) clearTimeout(state.autoExpireTimer);
      state.autoExpireTimer = setTimeout(() => {
        deactivateEmergencyMode(true);
      }, 2 * 60 * 60 * 1000);
    }

    // 6. Emergency Contacts WhatsApp/SMS broadcast
    sendEmergencyBroadcast();

    showToast('🚨 EMERGENCY ACTIVATED! Siren playing and alert broadcasted to guardians.', 'error');
  }

  async function deactivateEmergencyMode(isAutoExpired = false) {
    state.isAlarmActive = false;
    if (state.autoExpireTimer) {
      clearTimeout(state.autoExpireTimer);
      state.autoExpireTimer = null;
    }

    // Stop audio & visuals
    stopSirenSound();
    stopStrobeOverlay();
    stopLiveLocationTracking();

    // Reset button UI
    updateHeroSosButton(false);

    // Broadcast resolution to Safety Group in Cloud Firestore
    if (state.currentGroup && state.currentUser) {
      broadcastSosToFirestore(false, isAutoExpired);
    }

    const msg = isAutoExpired
      ? 'SOS emergency alert automatically ended after 2 hours.'
      : 'Emergency alarm deactivated. You have been marked safe.';
    showToast(msg, isAutoExpired ? 'info' : 'success');
  }

  function updateHeroSosButton(isActive) {
    const sosBtn = document.getElementById('sosTriggerBtn');
    const label = document.getElementById('sosBtnLabel');
    const subtext = document.getElementById('sosBtnSubtext');

    if (isActive) {
      if (sosBtn) sosBtn.classList.add('active-alarm');
      if (label) label.textContent = 'STOP';
      if (subtext) subtext.textContent = 'I\'M SAFE';
    } else {
      if (sosBtn) sosBtn.classList.remove('active-alarm');
      if (label) label.textContent = 'SOS';
      if (subtext) subtext.textContent = 'TAP FOR HELP';
    }
  }

  async function broadcastSosToFirestore(isActive, isAutoExpired = false) {
    if (!state.currentGroup || !state.currentUser) return;
    const user = state.currentUser;
    const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'Guardian');
    const db = firebase.firestore();
    const groupId = state.currentGroup.id;
    const sosDocRef = db.collection('groups').doc(groupId).collection('sos').doc(user.uid);
    const messagesColRef = db.collection('groups').doc(groupId).collection('messages');

    try {
      if (isActive) {
        const coords = state.currentCoords;
        await sosDocRef.set({
          groupId: groupId,
          userId: user.uid,
          userName: displayName,
          active: true,
          startedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          location: {
            lat: coords ? coords.lat : null,
            lng: coords ? coords.lng : null,
            accuracy: coords ? coords.accuracy : null,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            mapsUrl: coords ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}` : null,
            isAvailable: Boolean(coords)
          }
        });

        // Write automatic emergency message
        const newMsgDoc = await messagesColRef.add({
          groupId: groupId,
          userId: user.uid,
          userName: displayName,
          type: 'sos_alert',
          text: `🚨 SOS ALERT: ${displayName} needs help. Live location sharing is active.`,
          location: coords ? {
            lat: coords.lat,
            lng: coords.lng,
            accuracy: coords.accuracy,
            mapsUrl: `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
          } : null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        state.activeSosMsgId = newMsgDoc.id;
      } else {
        state.activeSosMsgId = null;
        await sosDocRef.set({
          active: false,
          endedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          autoExpired: isAutoExpired
        }, { merge: true });

        const resolutionText = isAutoExpired
          ? `⏰ ${displayName}'s SOS alert has automatically ended after 2 hours.`
          : `✅ ${displayName} has marked themselves SAFE. SOS has ended.`;

        await messagesColRef.add({
          groupId: groupId,
          userId: user.uid,
          userName: displayName,
          type: 'sos_resolved',
          text: resolutionText,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (err) {
      console.error('[SheSafe Broadcast SOS Error]:', {
        code: err.code || 'UNKNOWN',
        message: err.message,
        name: err.name,
        stack: err.stack,
        raw: err
      });
    }
  }

  function toggleStrobe() {
    if (state.strobeActive) {
      stopStrobeOverlay();
    } else {
      startStrobeOverlay();
    }
  }

  function startStrobeOverlay() {
    state.strobeActive = true;
    const overlay = document.getElementById('strobeOverlay');
    if (overlay) overlay.classList.add('active');
  }

  function stopStrobeOverlay() {
    state.strobeActive = false;
    const overlay = document.getElementById('strobeOverlay');
    if (overlay) overlay.classList.remove('active');
  }

  /* --------------------------------------------------------------------------
     5. CONTACTS & ALERTS BROADCAST
     -------------------------------------------------------------------------- */
  function sendEmergencyBroadcast() {
    if (!state.contacts || state.contacts.length === 0) {
      showToast('No emergency contacts saved! Please add contacts below.', 'error');
      return;
    }

    const firstContact = state.contacts[0];
    const msg = createEmergencyMessage();

    // Open WhatsApp or SMS with pre-filled urgent dispatch
    const cleanPhone = firstContact.phone.replace(/[^0-9]/g, '');
    const waUrl = `https://wa.me/${cleanPhone}?text=${msg}`;
    
    // Automatically trigger alert modal
    const alertModal = document.getElementById('sosBroadcastModal');
    if (alertModal) {
      renderBroadcastContactsList();
      alertModal.classList.add('open');
    }
  }

  function renderBroadcastContactsList() {
    const list = document.getElementById('broadcastContactsList');
    if (!list) return;

    const msg = createEmergencyMessage();
    list.innerHTML = '';

    state.contacts.forEach((c) => {
      const cleanPhone = c.phone.replace(/[^0-9]/g, '');
      const waUrl = `https://wa.me/${cleanPhone}?text=${msg}`;
      const smsUrl = `sms:${c.phone}?body=${msg}`;
      const telUrl = `tel:${c.phone}`;

      const item = document.createElement('div');
      item.className = 'contact-card';
      item.style.marginBottom = '8px';
      item.innerHTML = `
        <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
        <div class="contact-meta">
          <div class="contact-name">${escapeHtml(c.name)} <span class="contact-relation-badge">${escapeHtml(c.relation || 'Contact')}</span></div>
          <div class="contact-phone">${escapeHtml(c.phone)}</div>
        </div>
        <div class="contact-actions">
          <a href="${waUrl}" target="_blank" rel="noopener" class="action-pill-btn primary-action" style="padding: 6px 12px; font-size: 0.8rem;">
            WhatsApp
          </a>
          <a href="${smsUrl}" class="action-pill-btn" style="padding: 6px 12px; font-size: 0.8rem;">
            SMS
          </a>
          <a href="${telUrl}" class="contact-btn" title="Call">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
          </a>
        </div>
      `;
      list.appendChild(item);
    });
  }

  function renderContactsList() {
    const list = document.getElementById('contactsListContainer');
    const countBadge = document.getElementById('contactsCountBadge');
    if (!list) return;

    if (countBadge) countBadge.textContent = `${state.contacts.length} saved`;

    if (state.contacts.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 2rem 1rem; color: var(--text-dim);">
          <p>No emergency contacts yet.</p>
          <p style="font-size: 0.85rem; margin-top: 4px;">Add your family or trusted friends using the form.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = '';
    const msg = createEmergencyMessage();

    state.contacts.forEach((contact) => {
      const cleanPhone = contact.phone.replace(/[^0-9]/g, '');
      const waUrl = `https://wa.me/${cleanPhone}?text=${msg}`;
      const telUrl = `tel:${contact.phone}`;

      const card = document.createElement('div');
      card.className = 'contact-card';
      card.innerHTML = `
        <div class="contact-avatar">${contact.name.charAt(0).toUpperCase()}</div>
        <div class="contact-meta">
          <div class="contact-name">
            ${escapeHtml(contact.name)}
            <span class="contact-relation-badge">${escapeHtml(contact.relation || 'Contact')}</span>
          </div>
          <div class="contact-phone">${escapeHtml(contact.phone)}</div>
        </div>
        <div class="contact-actions">
          <a href="${waUrl}" target="_blank" rel="noopener" class="contact-btn" title="Send WhatsApp Alert">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
          </a>
          <a href="${telUrl}" class="contact-btn" title="Direct Phone Call">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
          </a>
          <button class="contact-btn delete-btn" data-id="${contact.id}" title="Remove Contact">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;

      card.querySelector('.delete-btn').addEventListener('click', () => {
        deleteContact(contact.id);
      });

      list.appendChild(card);
    });
  }

  async function syncContactToFirestore(contact, action) {
    const firestoreRef = getFirestoreContactsRef();
    if (!firestoreRef) return;
    try {
      if (action === 'add') {
        await firestoreRef.doc(contact.id).set({
          name: contact.name,
          phone: contact.phone,
          relation: contact.relation,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else if (action === 'delete') {
        await firestoreRef.doc(contact.id).delete();
      }
    } catch (e) {
      console.warn('Firestore sync notice:', e.message);
    }
  }

  function addContact(e) {
    e.preventDefault();
    const nameInput = document.getElementById('contactNameInput');
    const phoneInput = document.getElementById('contactPhoneInput');
    const relationSelect = document.getElementById('contactRelationSelect');

    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const relation = relationSelect.value;

    if (!name || !phone) {
      showToast('Please provide both name and phone number', 'error');
      return;
    }

    const newContact = {
      id: Date.now().toString(),
      name,
      phone,
      relation
    };

    state.contacts.push(newContact);
    saveContacts();
    renderContactsList();
    syncContactToFirestore(newContact, 'add');

    nameInput.value = '';
    phoneInput.value = '';
    showToast(`Added ${name} to trusted contacts!`, 'success');
  }

  function deleteContact(id) {
    state.contacts = state.contacts.filter((c) => c.id !== id);
    saveContacts();
    renderContactsList();
    syncContactToFirestore({ id }, 'delete');
    showToast('Contact removed', 'success');
  }

  function clearAllContacts() {
    if (confirm('Are you sure you want to remove all emergency contacts?')) {
      const oldContacts = [...state.contacts];
      state.contacts = [];
      saveContacts();
      renderContactsList();
      oldContacts.forEach((c) => syncContactToFirestore(c, 'delete'));
      showToast('All contacts cleared', 'success');
    }
  }

  /* --------------------------------------------------------------------------
     5B. SHESAFE SAFETY GROUP SYSTEM (FIRESTORE REAL-TIME END-TO-END)
     -------------------------------------------------------------------------- */

  // Cryptographically secure, non-guessable Group ID generator (GRP-XXXX-XXXX)
  function generateGroupId() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const randVals = new Uint8Array(8);
    crypto.getRandomValues(randVals);
    let p1 = '';
    let p2 = '';
    for (let i = 0; i < 4; i++) {
      p1 += chars[randVals[i] % chars.length];
      p2 += chars[randVals[i + 4] % chars.length];
    }
    return `GRP-${p1}-${p2}`;
  }

  // Secure Group Join Credential generator (SAFE-XXXXXX)
  function generateGroupPassword() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const randVals = new Uint8Array(6);
    crypto.getRandomValues(randVals);
    let p = '';
    for (let i = 0; i < 6; i++) {
      p += chars[randVals[i] % chars.length];
    }
    return `SAFE-${p}`;
  }

  // Cryptographic Hashing using browser Web Crypto API (SHA-256 + Salt)
  // Ensures plaintext passwords are NEVER transmitted or stored in Firestore
  async function hashGroupPassword(password, groupId) {
    const salt = `shesafe_${groupId}`;
    const enc = new TextEncoder();
    const data = enc.encode(`${salt}:${password}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function showGroupAlert(message, type = 'error') {
    const alertBox = document.getElementById('groupAlertBox');
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `auth-alert ${type === 'error' ? 'auth-alert-error' : 'auth-alert-success'}`;
    alertBox.style.display = 'block';
  }

  function clearGroupAlert() {
    const alertBox = document.getElementById('groupAlertBox');
    if (!alertBox) return;
    alertBox.textContent = '';
    alertBox.style.display = 'none';
  }

  function setGroupLoading(action, isLoading) {
    const btn = document.getElementById(action === 'create' ? 'createGroupSubmitBtn' : 'joinGroupSubmitBtn');
    if (!btn) return;
    btn.disabled = isLoading;
    const txt = btn.querySelector('.btn-text');
    const spin = btn.querySelector('.btn-spinner');
    if (txt) txt.style.display = isLoading ? 'none' : 'inline';
    if (spin) spin.style.display = isLoading ? 'inline' : 'none';
  }

  function cleanupGroupSubscriptions() {
    if (typeof state.groupListenerUnsub === 'function') {
      state.groupListenerUnsub();
      state.groupListenerUnsub = null;
    }
    if (typeof state.membersListenerUnsub === 'function') {
      state.membersListenerUnsub();
      state.membersListenerUnsub = null;
    }
    if (typeof state.groupSosListenerUnsub === 'function') {
      state.groupSosListenerUnsub();
      state.groupSosListenerUnsub = null;
    }
    if (typeof state.groupMessagesListenerUnsub === 'function') {
      state.groupMessagesListenerUnsub();
      state.groupMessagesListenerUnsub = null;
    }
    if (typeof state.userDocListenerUnsub === 'function') {
      state.userDocListenerUnsub();
      state.userDocListenerUnsub = null;
    }
    stopLiveLocationTracking();
    if (state.autoExpireTimer) {
      clearTimeout(state.autoExpireTimer);
      state.autoExpireTimer = null;
    }
    state.activeRemoteAlert = null;
    state.currentGroupSos = null;
    state.groupMessages = [];
    state.activeSosMsgId = null;
    closeIncomingSOSModal();
  }

  // Real-time synchronization of the user's active Safety Group
  function syncUserSafetyGroup() {
    cleanupGroupSubscriptions();
    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : state.currentUser;
    if (!user || typeof firebase === 'undefined' || !firebase.firestore || !window.__IS_FIREBASE_CONFIGURED__) {
      state.currentGroup = null;
      state.groupMembers = [];
      renderSafetyGroupUI();
      return;
    }

    const db = firebase.firestore();
    const userDocRef = db.collection('users').doc(user.uid);

    state.userDocListenerUnsub = userDocRef.onSnapshot(
      (docSnapshot) => {
        const userData = docSnapshot.data();
        const groupId = userData ? userData.currentGroupId : null;

        if (!groupId) {
          cleanupGroupSubscriptions();
          state.currentGroup = null;
          state.groupMembers = [];
          renderSafetyGroupUI();
          return;
        }

        subscribeToGroupData(groupId);
      },
      (err) => {
        console.warn('[SheSafe Firestore User Doc Listener Notice]:', err.code, err.message);
        if (err.code === 'permission-denied') {
          showGroupAlert(`[Firebase Firestore Error: ${err.code}]\n${err.message}\n\nUnable to access user document "users/${user.uid}". Please publish the rules from firestore.rules in your Firebase Console.`, 'error');
        }
      }
    );
  }

  function subscribeToGroupData(groupId) {
    const db = firebase.firestore();
    const groupRef = db.collection('groups').doc(groupId);

    if (typeof state.groupListenerUnsub === 'function') state.groupListenerUnsub();

    state.groupListenerUnsub = groupRef.onSnapshot(
      (doc) => {
        if (!doc.exists) {
          // Group was disbanded or removed
          const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : state.currentUser;
          if (user) {
            db.collection('users').doc(user.uid).update({
              currentGroupId: firebase.firestore.FieldValue.delete()
            }).catch(() => {});
          }
          cleanupGroupSubscriptions();
          state.currentGroup = null;
          state.groupMembers = [];
          renderSafetyGroupUI();
          return;
        }

        const data = doc.data();
        state.currentGroup = {
          id: doc.id,
          ...data
        };

        // Check if join credential was stored in session storage for this group
        const cachedPass = sessionStorage.getItem(`shesafe_cred_${doc.id}`);
        if (cachedPass) {
          state.revealedActivePassword = cachedPass;
        }

        renderSafetyGroupUI();
        subscribeToGroupMembers(groupId);
        subscribeToGroupSOS(groupId);
        subscribeToGroupMessages(groupId);
      },
      (err) => {
        console.warn('[SheSafe Firestore Group Listener Notice]:', err.code, err.message);
        if (err.code === 'permission-denied') {
          cleanupGroupSubscriptions();
          state.currentGroup = null;
          state.groupMembers = [];
          renderSafetyGroupUI();
          showGroupAlert(`[Firebase Firestore Error: ${err.code}]\n${err.message}\n\nAccess denied for "groups/${groupId}". Cloud Firestore rules on Firebase Console are currently blocking access.`, 'error');
        }
      }
    );
  }

  function subscribeToGroupMembers(groupId) {
    const db = firebase.firestore();
    const membersRef = db.collection('groups').doc(groupId).collection('members');

    if (typeof state.membersListenerUnsub === 'function') state.membersListenerUnsub();

    state.membersListenerUnsub = membersRef.onSnapshot(
      (snapshot) => {
        const list = [];
        snapshot.forEach((mDoc) => {
          list.push({ id: mDoc.id, ...mDoc.data() });
        });
        state.groupMembers = list;
        renderSafetyGroupUI();
      },
      (err) => {
        console.warn('Group members subcollection notice:', err.message);
      }
    );
  }

  // Cross-device Real-Time SOS Listener
  function subscribeToGroupSOS(groupId) {
    const db = firebase.firestore();
    const sosRef = db.collection('groups').doc(groupId).collection('sos');

    if (typeof state.groupSosListenerUnsub === 'function') state.groupSosListenerUnsub();

    state.groupSosListenerUnsub = sosRef.onSnapshot(
      (snapshot) => {
        const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : state.currentUser;
        const now = Date.now();
        const activeAlerts = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data && data.active === true) {
            let startedMs = now;
            if (data.startedAt) {
              startedMs = data.startedAt.toDate ? data.startedAt.toDate().getTime() : new Date(data.startedAt).getTime();
            }
            const ageMs = now - startedMs;
            const isExpired = ageMs > 2 * 60 * 60 * 1000; // Auto-expire after 2 hours

            if (isExpired) {
              // Automatically resolve expired SOS
              if (user && data.userId === user.uid) {
                doc.ref.update({
                  active: false,
                  endedAt: firebase.firestore.FieldValue.serverTimestamp(),
                  autoExpired: true
                }).catch((err) => console.warn('Could not auto-expire SOS:', err.message));
              }
            } else {
              activeAlerts.push({
                id: doc.id,
                startedMs: startedMs,
                ageMs: ageMs,
                ...data
              });
            }
          }
        });

        handleGroupSosStateChange(activeAlerts);
      },
      (err) => {
        console.warn('[SheSafe Firestore SOS Listener Notice]:', err.code, err.message);
      }
    );
  }

  function handleGroupSosStateChange(activeAlerts) {
    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : state.currentUser;
    const currentUid = user ? user.uid : null;

    const isOwnBroadcast = activeAlerts.some((a) => a.userId === currentUid);
    const remoteAlert = activeAlerts.find((a) => a.userId !== currentUid);

    state.currentGroupSos = activeAlerts.length > 0 ? activeAlerts[0] : null;

    if (remoteAlert) {
      // Remote member triggered SOS!
      state.activeRemoteAlert = remoteAlert;

      // Play emergency siren if not explicitly silenced
      if (!state.isSilencedRemoteSiren) {
        startSirenSound();
      }
      startStrobeOverlay();

      // Show incoming SOS modal if not already acknowledged
      const alertSessionId = `${remoteAlert.userId}_${remoteAlert.startedMs}`;
      if (state.acknowledgedAlertId !== alertSessionId) {
        displayIncomingSOSModal(remoteAlert);
      }

      renderCircleSosStatusUI(remoteAlert, false);
    } else if (isOwnBroadcast) {
      // Current user is broadcasting
      state.activeRemoteAlert = null;
      closeIncomingSOSModal();
      updateHeroSosButton(true);
      renderCircleSosStatusUI(activeAlerts.find((a) => a.userId === currentUid), true);
    } else {
      // All guardians safe
      state.activeRemoteAlert = null;
      state.isSilencedRemoteSiren = false;
      state.acknowledgedAlertId = null;

      if (!state.isAlarmActive) {
        stopSirenSound();
        stopStrobeOverlay();
        updateHeroSosButton(false);
      }

      closeIncomingSOSModal();
      renderCircleSosStatusUI(null, false);
    }
  }

  function renderCircleSosStatusUI(alertData, isOwn) {
    const card = document.getElementById('groupSosStatusCard');
    const indicator = document.getElementById('circleStatusIndicator');
    const title = document.getElementById('circleStatusTitle');
    const desc = document.getElementById('circleStatusDesc');
    const detailsBox = document.getElementById('circleActiveSosDetails');
    const nameEl = document.getElementById('sosBroadcasterName');
    const timeTag = document.getElementById('sosStartedTimeTag');
    const coordsLead = document.getElementById('circleSosCoordsLead');
    const freshnessTag = document.getElementById('circleSosFreshnessTag');
    const mapsBtn = document.getElementById('circleSosMapsBtn');
    const stopBtn = document.getElementById('circleStopSosBtn');

    if (!card) return;

    if (!alertData) {
      // Normal Safe state
      card.className = 'circle-sos-monitor safe';
      if (indicator) indicator.className = 'circle-status-indicator safe-indicator';
      if (title) title.textContent = 'Circle Status: All Guardians Safe';
      if (desc) desc.textContent = 'Live SOS monitoring is active. If any member triggers an emergency, all connected devices will sound an alarm.';
      if (detailsBox) detailsBox.style.display = 'none';
      return;
    }

    // Active Emergency state
    card.className = 'circle-sos-monitor emergency';
    if (indicator) indicator.className = 'circle-status-indicator emergency-indicator';
    if (detailsBox) detailsBox.style.display = 'flex';

    if (isOwn) {
      if (title) title.textContent = '🚨 You Are Broadcasting Live SOS to Your Circle';
      if (desc) desc.textContent = 'Your guardians have been alerted with your live location. Press "I\'m Safe" when you are out of danger.';
      if (nameEl) nameEl.textContent = 'You';
      if (stopBtn) {
        stopBtn.style.display = 'inline-flex';
        stopBtn.onclick = () => deactivateEmergencyMode(false);
      }
    } else {
      if (title) title.textContent = `🚨 ACTIVE EMERGENCY: ${escapeHtml(alertData.userName || 'Guardian')} Needs Help!`;
      if (desc) desc.textContent = 'A member of your circle has activated SOS. Check their live coordinates below and respond immediately.';
      if (nameEl) nameEl.textContent = escapeHtml(alertData.userName || 'Guardian');
      if (stopBtn) stopBtn.style.display = 'none';
    }

    // Time elapsed
    const mins = Math.max(0, Math.floor((alertData.ageMs || 0) / 60000));
    if (timeTag) timeTag.textContent = mins === 0 ? 'Started just now' : `Started ${mins}m ago`;

    // Location details
    const loc = alertData.location;
    if (loc && loc.isAvailable && loc.lat && loc.lng) {
      if (coordsLead) {
        const acc = loc.accuracy ? ` (±${loc.accuracy}m)` : '';
        coordsLead.textContent = `${Number(loc.lat).toFixed(4)}, ${Number(loc.lng).toFixed(4)}${acc}`;
      }

      // Freshness calculation
      let locTime = Date.now();
      if (loc.timestamp) {
        locTime = loc.timestamp.toDate ? loc.timestamp.toDate().getTime() : new Date(loc.timestamp).getTime();
      }
      const locAgeSec = Math.floor((Date.now() - locTime) / 1000);

      if (freshnessTag) {
        if (locAgeSec < 60) {
          freshnessTag.className = 'location-freshness-tag freshness-live';
          freshnessTag.textContent = '🟢 Live GPS';
        } else if (locAgeSec < 300) {
          freshnessTag.className = 'location-freshness-tag freshness-stale';
          freshnessTag.textContent = `🟡 ${Math.floor(locAgeSec / 60)}m ago`;
        } else {
          freshnessTag.className = 'location-freshness-tag freshness-unavailable';
          freshnessTag.textContent = '🔴 Stale GPS';
        }
      }

      if (mapsBtn) {
        mapsBtn.href = loc.mapsUrl || `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
        mapsBtn.style.display = 'inline-flex';
      }
    } else {
      if (coordsLead) coordsLead.textContent = 'GPS location unavailable (Permission denied or signal lost)';
      if (freshnessTag) {
        freshnessTag.className = 'location-freshness-tag freshness-unavailable';
        freshnessTag.textContent = '⚠️ No GPS';
      }
      if (mapsBtn) mapsBtn.style.display = 'none';
    }
  }

  function displayIncomingSOSModal(alertData) {
    const modal = document.getElementById('incomingSosModal');
    const title = document.getElementById('incomingSosTitle');
    const desc = document.getElementById('incomingSosDesc');
    const coordsText = document.getElementById('incomingSosCoordsText');
    const accText = document.getElementById('incomingSosAccuracyText');
    const timeBadge = document.getElementById('incomingSosTimeBadge');
    const mapsLink = document.getElementById('incomingSosMapsLink');

    if (!modal) return;

    if (title) title.textContent = `🚨 Emergency Alert: ${escapeHtml(alertData.userName || 'Guardian')}!`;
    if (desc) desc.textContent = `${escapeHtml(alertData.userName || 'Guardian')} triggered an emergency SOS signal in your Safety Circle and needs immediate assistance!`;

    const mins = Math.max(0, Math.floor((alertData.ageMs || 0) / 60000));
    if (timeBadge) timeBadge.textContent = mins === 0 ? 'Just now' : `${mins}m ago`;

    const loc = alertData.location;
    if (loc && loc.isAvailable && loc.lat && loc.lng) {
      if (coordsText) coordsText.textContent = `${Number(loc.lat).toFixed(4)}, ${Number(loc.lng).toFixed(4)}`;
      if (accText) accText.textContent = loc.accuracy ? `GPS Accuracy: ±${loc.accuracy}m` : 'GPS Position Locked';
      if (mapsLink) {
        mapsLink.href = loc.mapsUrl || `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
        mapsLink.style.display = 'inline-flex';
      }
    } else {
      if (coordsText) coordsText.textContent = 'Location coordinates unavailable (Permission denied on sender device)';
      if (accText) accText.textContent = 'Sender device could not acquire GPS fix';
      if (mapsLink) mapsLink.style.display = 'none';
    }

    modal.classList.add('open');
  }

  function closeIncomingSOSModal() {
    const modal = document.getElementById('incomingSosModal');
    if (modal) modal.classList.remove('open');
  }

  // Real-time Emergency Messages in Safety Circle
  function subscribeToGroupMessages(groupId) {
    const db = firebase.firestore();
    const msgsRef = db.collection('groups').doc(groupId).collection('messages').orderBy('createdAt', 'asc').limitToLast(50);

    if (typeof state.groupMessagesListenerUnsub === 'function') state.groupMessagesListenerUnsub();

    state.groupMessagesListenerUnsub = msgsRef.onSnapshot(
      (snapshot) => {
        const list = [];
        snapshot.forEach((mDoc) => {
          list.push({ id: mDoc.id, ...mDoc.data() });
        });
        state.groupMessages = list;
        renderGroupMessages();
      },
      (err) => {
        console.warn('[SheSafe Messages Listener Notice]:', err.code, err.message);
      }
    );
  }

  function renderGroupMessages() {
    const listEl = document.getElementById('groupMessagesList');
    if (!listEl) return;

    if (!state.groupMessages || state.groupMessages.length === 0) {
      listEl.innerHTML = '<div class="empty-messages-hint">No emergency messages yet. Circle communications will appear here in real time.</div>';
      return;
    }

    listEl.innerHTML = '';
    const currentUid = state.currentUser ? state.currentUser.uid : null;

    state.groupMessages.forEach((msg) => {
      const isOwn = currentUid && msg.userId === currentUid;
      const item = document.createElement('div');
      item.className = `message-item ${msg.type || 'chat'} ${isOwn ? 'is-own' : ''}`;

      let timeStr = 'Just now';
      if (msg.createdAt) {
        try {
          const d = msg.createdAt.toDate ? msg.createdAt.toDate() : new Date(msg.createdAt);
          timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) {}
      }

      let badge = '';
      if (msg.type === 'sos_alert') {
        badge = '<span class="emergency-tag-urgent" style="font-size: 0.68rem; margin-right: 6px;">SOS ALERT</span>';
      } else if (msg.type === 'sos_resolved') {
        badge = '<span style="background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700; margin-right: 6px;">SAFE</span>';
      }

      let mapBtnHtml = '';
      if (msg.location && msg.location.lat && msg.location.lng) {
        const mapsUrl = msg.location.mapsUrl || `https://www.google.com/maps?q=${msg.location.lat},${msg.location.lng}`;
        mapBtnHtml = `
          <div>
            <a href="${mapsUrl}" target="_blank" rel="noopener" class="message-map-btn">
              📍 View Location on Google Maps (${Number(msg.location.lat).toFixed(4)}, ${Number(msg.location.lng).toFixed(4)})
            </a>
          </div>
        `;
      }

      item.innerHTML = `
        <div class="message-header">
          <div class="message-sender">${badge}${escapeHtml(msg.userName || 'Guardian')}${isOwn ? ' (You)' : ''}</div>
          <div class="message-time">${timeStr}</div>
        </div>
        <div class="message-body">${escapeHtml(msg.text || '')}</div>
        ${mapBtnHtml}
      `;
      listEl.appendChild(item);
    });

    listEl.scrollTop = listEl.scrollHeight;
  }

  async function handleSendGroupMessage(e) {
    e.preventDefault();
    const input = document.getElementById('groupMessageInput');
    const text = input ? input.value.trim() : '';
    if (!text || !state.currentGroup || !state.currentUser) return;

    const user = state.currentUser;
    const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'Guardian');
    const db = firebase.firestore();

    try {
      await db.collection('groups').doc(state.currentGroup.id).collection('messages').add({
        groupId: state.currentGroup.id,
        userId: user.uid,
        userName: displayName,
        type: 'chat',
        text: text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if (input) input.value = '';
    } catch (err) {
      console.error('[SheSafe Send Message Error]:', err);
      showToast('Could not send message: ' + (err.message || err.code), 'error');
    }
  }

  // 1. CREATE SAFETY GROUP (via Trusted Cloud Function Backend)
  async function handleCreateGroup(e) {
    e.preventDefault();

    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    if (!user || !user.uid) {
      showGroupAlert('[Auth Error]: No authenticated Firebase user detected. Please sign in or create an account first.', 'error');
      return;
    }

    if (state.currentGroup) {
      showGroupAlert('You are already part of an active Safety Group. Please leave your current group first.', 'error');
      return;
    }

    const nameInput = document.getElementById('createGroupNameInput');
    const idInput = document.getElementById('createGroupIdInput');
    const passInput = document.getElementById('createGroupPasswordInput');

    const groupName = nameInput ? nameInput.value.trim() : '';
    const groupId = idInput ? idInput.value.trim().toUpperCase() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!groupName || !groupId || !password) {
      showGroupAlert('Please fill in Group Name, Group ID, and Join Credential.', 'error');
      return;
    }

    if (password.length < 4) {
      showGroupAlert('Join Credential / Password must be at least 4 characters.', 'error');
      return;
    }

    setGroupLoading('create', true);
    clearGroupAlert();

    try {
      console.log(`[SheSafe] Initializing Cloud Firestore write for group ${groupId}...`);
      const db = firebase.firestore();
      const groupRef = db.collection('groups').doc(groupId);
      const memberRef = groupRef.collection('members').doc(user.uid);
      const userRef = db.collection('users').doc(user.uid);
      const securityRef = groupRef.collection('private').doc('security');

      const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'Guardian');
      const salt = `shesafe_${groupId}`;
      const passwordHash = await hashGroupPassword(password, groupId);

      const batch = db.batch();
      batch.set(groupRef, {
        groupId: groupId,
        groupName: groupName,
        createdBy: user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        memberCount: 1,
        maxMembers: 4,
        membersList: [user.uid]
      });

      batch.set(securityRef, {
        passwordHash: passwordHash,
        salt: salt,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      batch.set(memberRef, {
        userId: user.uid,
        displayName: displayName,
        role: 'creator',
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      batch.set(userRef, {
        currentGroupId: groupId,
        displayName: displayName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await batch.commit();

      console.log(`[SheSafe] Successfully committed group ${groupId} batch to Cloud Firestore.`);
      state.revealedActivePassword = password;
      sessionStorage.setItem(`shesafe_cred_${groupId}`, password);

      showToast(`Safety Group "${groupName}" created successfully!`, 'success');
      showGroupAlert(`Safety Group "${groupName}" is active in Cloud Firestore!\nGroup ID: ${groupId}\nJoin Credential: ${password}`, 'success');

      if (nameInput) nameInput.value = '';
    } catch (err) {
      console.error('[SheSafe Firebase Error - Create Group]:', {
        code: err.code || 'UNKNOWN',
        message: err.message || 'Operation failed',
        name: err.name,
        stack: err.stack,
        raw: err
      });
      const errorCode = err.code || 'UNKNOWN_ERROR';
      const errorMsg = err.message || 'Operation failed';

      let realErrorDisplay = `[Firebase Error: ${errorCode}]\n${errorMsg}`;
      if (errorCode === 'permission-denied') {
        realErrorDisplay += `\n\nCloud Firestore rules denied this write. Please ensure you are logged in and rules allow creating group as creator.`;
      }

      showGroupAlert(realErrorDisplay, 'error');
      showToast(`Error: ${errorCode}`, 'error');
    } finally {
      setGroupLoading('create', false);
    }
  }

  // 2. JOIN SAFETY GROUP
  async function handleJoinGroup(e) {
    e.preventDefault();
    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    if (!user || !user.uid) {
      showGroupAlert('[Auth Error]: You must be signed in with a real Firebase user to join a Safety Group.', 'error');
      return;
    }

    if (state.currentGroup) {
      showGroupAlert('You are already part of an active Safety Group. You must leave your current group before joining another.', 'error');
      return;
    }

    const idInput = document.getElementById('joinGroupIdInput');
    const passInput = document.getElementById('joinGroupPasswordInput');

    const groupId = idInput ? idInput.value.trim().toUpperCase() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!groupId || !password) {
      showGroupAlert('Please enter both Group ID and Join Credential.', 'error');
      return;
    }

    setGroupLoading('join', true);
    clearGroupAlert();

    try {
      console.log(`[SheSafe] Verifying credentials for group ${groupId}...`);
      const db = firebase.firestore();
      const groupRef = db.collection('groups').doc(groupId);
      const securityRef = groupRef.collection('private').doc('security');
      const memberRef = groupRef.collection('members').doc(user.uid);
      const userRef = db.collection('users').doc(user.uid);

      // Verify group security document
      const secDoc = await securityRef.get();
      if (!secDoc.exists) {
        throw { code: 'not-found', message: `Safety Group "${groupId}" was not found or has no security credentials. Please check the Group ID.` };
      }

      const candidateHash = await hashGroupPassword(password, groupId);
      if (secDoc.data().passwordHash !== candidateHash) {
        throw { code: 'permission-denied', message: 'Invalid Join Credential / Password. Access denied.' };
      }

      const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'Guardian');
      const batch = db.batch();

      batch.update(groupRef, {
        memberCount: firebase.firestore.FieldValue.increment(1),
        membersList: firebase.firestore.FieldValue.arrayUnion(user.uid)
      });

      batch.set(memberRef, {
        userId: user.uid,
        displayName: displayName,
        role: 'member',
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      batch.set(userRef, {
        currentGroupId: groupId,
        displayName: displayName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await batch.commit();

      console.log(`[SheSafe] Successfully joined group ${groupId} via Cloud Firestore.`);
      state.revealedActivePassword = password;
      sessionStorage.setItem(`shesafe_cred_${groupId}`, password);

      showToast(`Successfully joined Safety Group ${groupId}!`, 'success');
      showGroupAlert(`Connected to Safety Group ${groupId}! Your safety circle is active.`, 'success');

      if (idInput) idInput.value = '';
      if (passInput) passInput.value = '';
    } catch (err) {
      console.error('[SheSafe Firebase Error - Join Group]:', {
        code: err.code || 'UNKNOWN',
        message: err.message || 'Operation failed',
        name: err.name,
        stack: err.stack,
        raw: err
      });
      const errorCode = err.code || 'UNKNOWN_ERROR';
      const errorMsg = err.message || 'Operation failed';

      let realErrorDisplay = `[Firebase Error: ${errorCode}]\n${errorMsg}`;
      if (errorCode === 'permission-denied') {
        realErrorDisplay = `[Access Denied / Verification Failed]: Invalid Group ID or Join Credential, or this group already reached max capacity (4 members).`;
      } else if (errorCode === 'not-found') {
        realErrorDisplay = `[Not Found]: Group "${groupId}" was not found. Please verify the Group ID.`;
      }

      showGroupAlert(realErrorDisplay, 'error');
      showToast(`Error: ${errorCode}`, 'error');
    } finally {
      setGroupLoading('join', false);
    }
  }

  // 3. LEAVE SAFETY GROUP
  async function handleLeaveGroup() {
    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    if (!state.currentGroup || !user) return;
    const isCreator = state.currentGroup.createdBy === user.uid;
    const isSoleMember = (state.currentGroup.memberCount || 1) <= 1;

    const confirmMsg = isCreator && isSoleMember
      ? 'You are the only member and creator of this group. Leaving will disband and permanently delete this Safety Group. Continue?'
      : 'Are you sure you want to leave this Safety Group?';

    if (!confirm(confirmMsg)) return;

    try {
      const groupId = state.currentGroup.id;
      const db = firebase.firestore();
      const groupRef = db.collection('groups').doc(groupId);
      const memberRef = groupRef.collection('members').doc(user.uid);
      const userRef = db.collection('users').doc(user.uid);
      const secRef = groupRef.collection('private').doc('security');

      const batch = db.batch();
      if (isCreator && isSoleMember) {
        batch.delete(memberRef);
        batch.delete(secRef);
        batch.delete(groupRef);
      } else {
        batch.update(groupRef, {
          memberCount: firebase.firestore.FieldValue.increment(-1),
          membersList: firebase.firestore.FieldValue.arrayRemove(user.uid)
        });
        batch.delete(memberRef);
      }

      batch.update(userRef, {
        currentGroupId: firebase.firestore.FieldValue.delete()
      });

      await batch.commit();

      sessionStorage.removeItem(`shesafe_cred_${groupId}`);
      state.revealedActivePassword = null;
      state.isPasswordRevealed = false;
      cleanupGroupSubscriptions();
      state.currentGroup = null;
      state.groupMembers = [];
      renderSafetyGroupUI();
      clearGroupAlert();
      showToast('You have left the Safety Group.', 'info');
    } catch (err) {
      console.error('[SheSafe Firebase Error - Leave Group]:', {
        code: err.code || 'UNKNOWN',
        message: err.message || 'Operation failed',
        name: err.name,
        stack: err.stack,
        raw: err
      });
      const errorCode = err.code || 'UNKNOWN';
      showToast(`Error leaving group: ${errorCode}`, 'error');
      showGroupAlert(`[Firebase Error: ${errorCode}]: ${err.message}`, 'error');
    }
  }

  // 4. SHARE INVITE
  function handleShareInvite() {
    if (!state.currentGroup) return;
    const groupId = state.currentGroup.id;
    const groupName = state.currentGroup.groupName || 'SheSafe Shield';
    const pass = state.revealedActivePassword || sessionStorage.getItem(`shesafe_cred_${groupId}`) || '(Ask group creator)';

    const inviteMsg = `🛡️ SheSafe Emergency Circle Invite 🛡️\nJoin our private Safety Group "${groupName}"!\n\nGroup ID: ${groupId}\nJoin Password: ${pass}\n\nOpen SheSafe and enter these credentials under Safety Group to connect: ${window.location.origin}`;

    if (navigator.share) {
      navigator.share({
        title: `Join SheSafe Safety Group: ${groupName}`,
        text: inviteMsg
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(inviteMsg).then(() => {
        showToast('Safety Group invite copied to clipboard! Share with your guardians.', 'success');
      }).catch(() => {
        showToast(`Group ID: ${groupId} (Copy manual)`, 'info');
      });
    }
  }

  // 5. RENDER SAFETY GROUP UI
  function renderSafetyGroupUI() {
    const noGroupState = document.getElementById('noGroupState');
    const activeGroupState = document.getElementById('activeGroupState');
    if (!noGroupState || !activeGroupState) return;

    if (state.currentGroup) {
      noGroupState.style.display = 'none';
      activeGroupState.style.display = 'block';

      const groupNameEl = document.getElementById('activeGroupName');
      const capacityBadgeEl = document.getElementById('activeGroupCapacityBadge');
      const roleBadgeEl = document.getElementById('activeUserRoleBadge');
      const groupIdEl = document.getElementById('activeGroupIdDisplay');
      const passwordEl = document.getElementById('activeGroupPasswordDisplay');
      const membersCountText = document.getElementById('membersCountText');

      const isCreator = state.currentUser && state.currentUser.uid === state.currentGroup.createdBy;
      const count = state.currentGroup.memberCount || 1;

      if (groupNameEl) groupNameEl.textContent = state.currentGroup.groupName || 'Safety Circle';
      if (capacityBadgeEl) capacityBadgeEl.textContent = `${count} / 4 Members`;
      if (membersCountText) membersCountText.textContent = count;

      if (roleBadgeEl) {
        roleBadgeEl.textContent = isCreator ? 'Creator / Admin' : 'Guardian Member';
        roleBadgeEl.style.background = isCreator ? 'rgba(124, 58, 237, 0.2)' : 'rgba(16, 185, 129, 0.15)';
        roleBadgeEl.style.color = isCreator ? '#c4b5fd' : '#34d399';
      }

      if (groupIdEl) groupIdEl.textContent = state.currentGroup.id;

      // Display join credential only when requested or available
      if (passwordEl) {
        if (state.isPasswordRevealed && state.revealedActivePassword) {
          passwordEl.textContent = state.revealedActivePassword;
        } else if (state.isPasswordRevealed && !state.revealedActivePassword) {
          passwordEl.textContent = '(Set on creation)';
        } else {
          passwordEl.textContent = '••••••••';
        }
      }

      renderGroupMembersGrid();
    } else {
      noGroupState.style.display = 'grid';
      activeGroupState.style.display = 'none';

      // Ensure fresh values in create inputs
      const idInput = document.getElementById('createGroupIdInput');
      const passInput = document.getElementById('createGroupPasswordInput');
      if (idInput && !idInput.value) idInput.value = generateGroupId();
      if (passInput && !passInput.value) passInput.value = generateGroupPassword();
    }
  }

  function renderGroupMembersGrid() {
    const grid = document.getElementById('groupMembersGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const members = state.groupMembers.length > 0 ? state.groupMembers : [
      {
        userId: state.currentUser ? state.currentUser.uid : '',
        displayName: state.currentUser ? (state.currentUser.displayName || state.currentUser.email.split('@')[0]) : 'You',
        role: (state.currentGroup && state.currentUser && state.currentUser.uid === state.currentGroup.createdBy) ? 'creator' : 'member',
        joinedAt: new Date()
      }
    ];

    members.forEach((m) => {
      const isYou = state.currentUser && m.userId === state.currentUser.uid;
      const initial = (m.displayName || 'U').charAt(0).toUpperCase();
      const card = document.createElement('div');
      card.className = 'member-card';

      let timeText = 'Joined recently';
      if (m.joinedAt) {
        try {
          const d = m.joinedAt.toDate ? m.joinedAt.toDate() : new Date(m.joinedAt);
          timeText = `Active since ${d.toLocaleDateString()}`;
        } catch (e) {}
      }

      const roleBadge = m.role === 'creator'
        ? '<span style="color: #c4b5fd; font-weight: 700;">👑 Group Creator</span>'
        : '<span style="color: #34d399; font-weight: 700;">🛡️ Guardian Member</span>';

      card.innerHTML = `
        <div class="member-avatar-box ${isYou ? 'is-you' : ''}">${escapeHtml(initial)}</div>
        <div class="member-info">
          <div class="member-name">
            ${escapeHtml(m.displayName || 'Guardian')}
            ${isYou ? '<span style="font-size: 0.74rem; color: #38bdf8; font-weight: 700;">(You)</span>' : ''}
          </div>
          <div class="member-meta">
            ${roleBadge} • <span style="font-size: 0.72rem;">${timeText}</span>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });

    // Vacant slots up to max 4 members
    const vacantCount = Math.max(0, 4 - members.length);
    for (let i = 0; i < vacantCount; i++) {
      const emptySlot = document.createElement('div');
      emptySlot.className = 'member-slot-empty';
      emptySlot.innerHTML = `<span>+ Open Guardian Slot (${members.length + i + 1}/4)</span>`;
      grid.appendChild(emptySlot);
    }
  }

  function toggleActiveCredentialVisibility() {
    state.isPasswordRevealed = !state.isPasswordRevealed;
    const btn = document.getElementById('toggleActiveCredBtn');
    if (btn) btn.textContent = state.isPasswordRevealed ? '🙈' : '👁️';
    renderSafetyGroupUI();
  }

  /* --------------------------------------------------------------------------
     6. FAKE CALL SIMULATOR (FOR ESCAPING AWKWARD OR UNSAFE SITUATIONS)
     -------------------------------------------------------------------------- */
  function scheduleFakeCall(seconds) {
    showToast(`Fake call incoming in ${seconds} seconds... Hold your phone ready!`, 'success');

    if (state.fakeCallTimeout) {
      clearTimeout(state.fakeCallTimeout);
    }

    state.fakeCallTimeout = setTimeout(() => {
      displayFakeIncomingCall();
    }, seconds * 1000);
  }

  function displayFakeIncomingCall() {
    const callerNames = ['Dad', 'Mom', 'Inspector Sharma', 'Office Boss', 'Priya (Home)'];
    const chosen = callerNames[Math.floor(Math.random() * callerNames.length)];

    const nameEl = document.getElementById('fakeCallerName');
    if (nameEl) nameEl.textContent = chosen;

    const modal = document.getElementById('fakeCallModal');
    if (modal) modal.classList.add('open');

    // Ring sound
    startRingtoneSound();
  }

  function answerFakeCall() {
    stopRingtoneSound();
    const statusEl = document.getElementById('fakeCallStatus');
    if (statusEl) statusEl.textContent = 'Connected (00:01)';

    const actions = document.getElementById('fakeCallActions');
    if (actions) {
      actions.innerHTML = `
        <button id="endFakeCallBtn" class="call-btn call-decline" style="margin: 0 auto;">
          <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
        </button>
      `;
      document.getElementById('endFakeCallBtn').addEventListener('click', dismissFakeCall);
    }

    showToast('Call connected. Speak aloud to safely excuse yourself!', 'success');
  }

  function dismissFakeCall() {
    stopRingtoneSound();
    const modal = document.getElementById('fakeCallModal');
    if (modal) modal.classList.remove('open');

    // Reset actions
    const actions = document.getElementById('fakeCallActions');
    if (actions) {
      actions.innerHTML = `
        <button id="declineFakeCallBtn" class="call-btn call-decline" title="Decline">
          <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
        </button>
        <button id="acceptFakeCallBtn" class="call-btn call-accept" title="Answer">
          <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
        </button>
      `;
      document.getElementById('declineFakeCallBtn').addEventListener('click', dismissFakeCall);
      document.getElementById('acceptFakeCallBtn').addEventListener('click', answerFakeCall);
    }
  }

  /* --------------------------------------------------------------------------
     7. WALK SAFE CHECK-IN COUNTDOWN TIMER
     -------------------------------------------------------------------------- */
  function startWalkTimer(minutes) {
    if (state.walkTimerInterval) clearInterval(state.walkTimerInterval);
    state.walkTimeRemaining = minutes * 60;
    updateWalkTimerDisplay();

    const startBtn = document.getElementById('startWalkBtn');
    if (startBtn) startBtn.textContent = 'Cancel Timer';

    state.walkTimerInterval = setInterval(() => {
      state.walkTimeRemaining--;
      updateWalkTimerDisplay();

      if (state.walkTimeRemaining <= 0) {
        clearInterval(state.walkTimerInterval);
        state.walkTimerInterval = null;
        if (startBtn) startBtn.textContent = 'Start Journey Timer';
        showToast('⚠️ Safe walk check-in missed! Triggering SOS now!', 'error');
        activateFullEmergencyMode();
      }
    }, 1000);

    showToast(`Journey timer set for ${minutes} mins. Check in before it ends!`, 'success');
  }

  function stopWalkTimer() {
    if (state.walkTimerInterval) {
      clearInterval(state.walkTimerInterval);
      state.walkTimerInterval = null;
    }
    state.walkTimeRemaining = 0;
    updateWalkTimerDisplay();

    const startBtn = document.getElementById('startWalkBtn');
    if (startBtn) startBtn.textContent = 'Start Journey Timer';
    showToast('Journey timer cancelled safely', 'success');
  }

  function updateWalkTimerDisplay() {
    const display = document.getElementById('walkTimerDisplay');
    if (!display) return;
    const m = Math.floor(state.walkTimeRemaining / 60);
    const s = state.walkTimeRemaining % 60;
    display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* --------------------------------------------------------------------------
     8. AMBIENT AUDIO EVIDENCE RECORDER (BROWSER MEDIARECORDER API)
     -------------------------------------------------------------------------- */
  async function toggleAudioEvidenceRecording() {
    const recordBtn = document.getElementById('recordEvidenceBtn');
    const statusText = document.getElementById('evidenceStatusText');

    if (!state.isRecording) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Microphone recording not supported on this browser', 'error');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.recordedChunks = [];
        state.mediaRecorder = new MediaRecorder(stream);

        state.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) state.recordedChunks.push(e.data);
        };

        state.mediaRecorder.onstop = () => {
          const blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
          const audioUrl = URL.createObjectURL(blob);
          const list = document.getElementById('recordingsList');
          if (list) {
            const timeStr = new Date().toLocaleTimeString();
            const item = document.createElement('div');
            item.style.cssText = 'background: var(--bg-input); padding: 8px 12px; border-radius: 8px; margin-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.85rem;';
            item.innerHTML = `
              <span>🎙️ Recorded at ${timeStr}</span>
              <div style="display:flex; gap:6px;">
                <audio controls src="${audioUrl}" style="height: 28px; width: 140px;"></audio>
                <a href="${audioUrl}" download="SheSafe_Evidence_${Date.now()}.webm" class="contact-btn" title="Download">⬇️</a>
              </div>
            `;
            list.prepend(item);
          }
          showToast('Audio evidence recording saved locally!', 'success');
        };

        state.mediaRecorder.start();
        state.isRecording = true;
        if (recordBtn) {
          recordBtn.textContent = '⏹️ Stop & Save Recording';
          recordBtn.style.background = 'var(--sos-red)';
          recordBtn.style.color = '#fff';
        }
        if (statusText) statusText.textContent = '🔴 Discreetly recording ambient audio...';
        showToast('Audio recorder running discreetly', 'success');
      } catch (err) {
        console.error('Audio capture error:', err);
        showToast('Microphone access denied', 'error');
      }
    } else {
      if (state.mediaRecorder) {
        state.mediaRecorder.stop();
        state.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      }
      state.isRecording = false;
      if (recordBtn) {
        recordBtn.textContent = '🎙️ Start Discreet Recording';
        recordBtn.style.background = '';
        recordBtn.style.color = '';
      }
      if (statusText) statusText.textContent = 'Ready to capture audio evidence';
    }
  }

  /* --------------------------------------------------------------------------
     9. STEALTH MODE / DISGUISE SCREEN (INSTANT ESCAPE)
     -------------------------------------------------------------------------- */
  function toggleStealthMode() {
    const screen = document.getElementById('stealthScreen');
    if (!screen) return;
    screen.classList.toggle('active');
    if (screen.classList.contains('active')) {
      showToast('Disguise Mode On. Press ESC or double-tap header to return', 'info');
    }
  }

  /* --------------------------------------------------------------------------
     10. THEME SWITCHER
     -------------------------------------------------------------------------- */
  function initTheme() {
    const saved = localStorage.getItem('shesafe_theme');
    if (saved === 'light') {
      document.body.classList.add('light-theme');
      updateThemeIcon(true);
    }
  }

  function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('shesafe_theme', isLight ? 'light' : 'dark');
    updateThemeIcon(isLight);
  }

  function updateThemeIcon(isLight) {
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.innerHTML = isLight
        ? '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'
        : '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
    }
  }

  /* --------------------------------------------------------------------------
     11. HELPLINE SEARCH FILTER
     -------------------------------------------------------------------------- */
  function filterHelplines(query) {
    const cards = document.querySelectorAll('.helpline-card');
    const term = query.toLowerCase().trim();

    cards.forEach((card) => {
      const text = card.textContent.toLowerCase();
      if (!term || text.includes(term)) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  }

  /* --------------------------------------------------------------------------
     12. TOAST NOTIFICATIONS & UTILS
     -------------------------------------------------------------------------- */
  function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
  }

  /* --------------------------------------------------------------------------
     13. EVENT LISTENERS
     -------------------------------------------------------------------------- */
  function setupEventListeners() {
    // SOS Main Button
    const sosBtn = document.getElementById('sosTriggerBtn');
    if (sosBtn) {
      sosBtn.addEventListener('click', () => {
        if (state.isAlarmActive) {
          deactivateEmergencyMode();
        } else {
          triggerSOSFlow();
        }
      });
    }

    // Cancel SOS button inside countdown modal
    const cancelSosBtn = document.getElementById('cancelSosBtn');
    if (cancelSosBtn) cancelSosBtn.addEventListener('click', cancelSOSCountdown);

    // Strobe Toggle
    const strobeBtn = document.getElementById('toggleStrobeBtn');
    if (strobeBtn) strobeBtn.addEventListener('click', toggleStrobe);

    // Share Live Location Button
    const shareLocBtn = document.getElementById('shareLocationBtn');
    if (shareLocBtn) {
      shareLocBtn.addEventListener('click', () => {
        requestLocationUpdate();
        const msg = createEmergencyMessage();
        if (navigator.share) {
          navigator.share({
            title: 'SheSafe Emergency Location Alert',
            text: decodeURIComponent(msg),
            url: getMapsUrl()
          }).catch(() => {});
        } else {
          const waUrl = `https://api.whatsapp.com/send?text=${msg}`;
          window.open(waUrl, '_blank');
        }
      });
    }

    // Copy Location Link
    const copyLocBtn = document.getElementById('copyLocationLinkBtn');
    if (copyLocBtn) {
      copyLocBtn.addEventListener('click', () => {
        const link = getMapsUrl();
        navigator.clipboard.writeText(link).then(() => {
          showToast('Google Maps location link copied to clipboard!', 'success');
        });
      });
    }

    // Contacts Form
    const addContactForm = document.getElementById('addContactForm');
    if (addContactForm) addContactForm.addEventListener('submit', addContact);

    const clearContactsBtn = document.getElementById('clearContactsBtn');
    if (clearContactsBtn) clearContactsBtn.addEventListener('click', clearAllContacts);

    const broadcastBtn = document.getElementById('broadcastAlertBtn');
    if (broadcastBtn) broadcastBtn.addEventListener('click', sendEmergencyBroadcast);

    // Fake Call Buttons
    const triggerFakeCall5 = document.getElementById('triggerFakeCall5');
    if (triggerFakeCall5) triggerFakeCall5.addEventListener('click', () => scheduleFakeCall(5));

    const triggerFakeCall15 = document.getElementById('triggerFakeCall15');
    if (triggerFakeCall15) triggerFakeCall15.addEventListener('click', () => scheduleFakeCall(15));

    const declineFakeCallBtn = document.getElementById('declineFakeCallBtn');
    if (declineFakeCallBtn) declineFakeCallBtn.addEventListener('click', dismissFakeCall);

    const acceptFakeCallBtn = document.getElementById('acceptFakeCallBtn');
    if (acceptFakeCallBtn) acceptFakeCallBtn.addEventListener('click', answerFakeCall);

    // Walk Timer Buttons
    const startWalkBtn = document.getElementById('startWalkBtn');
    if (startWalkBtn) {
      startWalkBtn.addEventListener('click', () => {
        if (state.walkTimerInterval) {
          stopWalkTimer();
        } else {
          const select = document.getElementById('walkDurationSelect');
          const mins = parseInt(select ? select.value : '15', 10);
          startWalkTimer(mins);
        }
      });
    }

    // Ambient Audio Evidence
    const recordEvidenceBtn = document.getElementById('recordEvidenceBtn');
    if (recordEvidenceBtn) recordEvidenceBtn.addEventListener('click', toggleAudioEvidenceRecording);

    // Stealth / Disguise Mode
    const stealthBtn = document.getElementById('stealthToggleBtn');
    if (stealthBtn) stealthBtn.addEventListener('click', toggleStealthMode);

    const stealthUnlock = document.getElementById('stealthUnlockBtn');
    if (stealthUnlock) stealthUnlock.addEventListener('click', toggleStealthMode);

    // Escape Key for instant Stealth Disguise
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggleStealthMode();
      }
    });

    // Theme Switcher
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    // Helpline Search Input
    const searchInput = document.getElementById('helplineSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => filterHelplines(e.target.value));
    }

    // Close modals on clicking backdrop
    document.querySelectorAll('.modal-backdrop').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('open');
          stopRingtoneSound();
        }
      });
    });

    // Modal Close Buttons
    document.querySelectorAll('.modal-close-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal-backdrop');
        if (modal) {
          modal.classList.remove('open');
          stopRingtoneSound();
        }
      });
    });

    // -------------------------------------------------------------------------
    // Firebase Authentication Listeners
    // -------------------------------------------------------------------------
    const tabLoginBtn = document.getElementById('tabLoginBtn');
    if (tabLoginBtn) tabLoginBtn.addEventListener('click', () => switchAuthTab('login'));

    const tabSignupBtn = document.getElementById('tabSignupBtn');
    if (tabSignupBtn) tabSignupBtn.addEventListener('click', () => switchAuthTab('signup'));

    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);

    const signupForm = document.getElementById('signupForm');
    if (signupForm) signupForm.addEventListener('submit', handleSignup);

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

    const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
    if (forgotPasswordBtn) forgotPasswordBtn.addEventListener('click', handleForgotPassword);

    document.querySelectorAll('.toggle-password-btn').forEach((btn) => {
      btn.addEventListener('click', () => togglePasswordVisibility(btn));
    });

    // -------------------------------------------------------------------------
    // Safety Group System Listeners
    // -------------------------------------------------------------------------
    const createGroupForm = document.getElementById('createGroupForm');
    if (createGroupForm) createGroupForm.addEventListener('submit', handleCreateGroup);

    const joinGroupForm = document.getElementById('joinGroupForm');
    if (joinGroupForm) joinGroupForm.addEventListener('submit', handleJoinGroup);

    const leaveGroupBtn = document.getElementById('leaveGroupBtn');
    if (leaveGroupBtn) leaveGroupBtn.addEventListener('click', handleLeaveGroup);

    const shareInviteBtn = document.getElementById('shareGroupInviteBtn');
    if (shareInviteBtn) shareInviteBtn.addEventListener('click', handleShareInvite);

    const refreshGroupIdBtn = document.getElementById('refreshGroupIdBtn');
    if (refreshGroupIdBtn) {
      refreshGroupIdBtn.addEventListener('click', () => {
        const idInput = document.getElementById('createGroupIdInput');
        if (idInput) {
          idInput.value = generateGroupId();
          showToast('New unique Group ID generated!', 'info');
        }
      });
    }

    const refreshGroupPassBtn = document.getElementById('refreshGroupPassBtn');
    if (refreshGroupPassBtn) {
      refreshGroupPassBtn.addEventListener('click', () => {
        const passInput = document.getElementById('createGroupPasswordInput');
        if (passInput) {
          passInput.value = generateGroupPassword();
          showToast('New secure join credential generated!', 'info');
        }
      });
    }

    const copyNewGroupIdBtn = document.getElementById('copyNewGroupIdBtn');
    if (copyNewGroupIdBtn) {
      copyNewGroupIdBtn.addEventListener('click', () => {
        const idInput = document.getElementById('createGroupIdInput');
        if (idInput && idInput.value) {
          navigator.clipboard.writeText(idInput.value).then(() => {
            showToast('Group ID copied to clipboard!', 'success');
          });
        }
      });
    }

    const copyActiveGroupIdBtn = document.getElementById('copyActiveGroupIdBtn');
    if (copyActiveGroupIdBtn) {
      copyActiveGroupIdBtn.addEventListener('click', () => {
        if (state.currentGroup && state.currentGroup.id) {
          navigator.clipboard.writeText(state.currentGroup.id).then(() => {
            showToast('Active Group ID copied to clipboard!', 'success');
          });
        }
      });
    }

    const copyActiveCredBtn = document.getElementById('copyActiveCredBtn');
    if (copyActiveCredBtn) {
      copyActiveCredBtn.addEventListener('click', () => {
        const pass = state.revealedActivePassword || (state.currentGroup ? sessionStorage.getItem(`shesafe_cred_${state.currentGroup.id}`) : '');
        if (pass) {
          navigator.clipboard.writeText(pass).then(() => {
            showToast('Join Credential copied to clipboard!', 'success');
          });
        } else {
          showToast('Password was configured upon group creation.', 'info');
        }
      });
    }

    const toggleActiveCredBtn = document.getElementById('toggleActiveCredBtn');
    if (toggleActiveCredBtn) {
      toggleActiveCredBtn.addEventListener('click', toggleActiveCredentialVisibility);
    }

    // -------------------------------------------------------------------------
    // Cross-Device SOS Emergency Listeners
    // -------------------------------------------------------------------------
    const silenceSirenBtn = document.getElementById('silenceSirenBtn');
    if (silenceSirenBtn) {
      silenceSirenBtn.addEventListener('click', () => {
        state.isSilencedRemoteSiren = true;
        stopSirenSound();
        stopStrobeOverlay();
        showToast('Siren silenced. Emergency alert remains active in your circle.', 'info');
      });
    }

    const dismissIncomingSosBtn = document.getElementById('dismissIncomingSosBtn');
    if (dismissIncomingSosBtn) {
      dismissIncomingSosBtn.addEventListener('click', () => {
        state.isSilencedRemoteSiren = true;
        stopSirenSound();
        stopStrobeOverlay();
        if (state.activeRemoteAlert) {
          state.acknowledgedAlertId = `${state.activeRemoteAlert.userId}_${state.activeRemoteAlert.startedMs}`;
        }
        closeIncomingSOSModal();
      });
    }

    const circleStopSosBtn = document.getElementById('circleStopSosBtn');
    if (circleStopSosBtn) {
      circleStopSosBtn.addEventListener('click', () => {
        deactivateEmergencyMode(false);
      });
    }

    const groupMessageForm = document.getElementById('groupMessageForm');
    if (groupMessageForm) {
      groupMessageForm.addEventListener('submit', handleSendGroupMessage);
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
