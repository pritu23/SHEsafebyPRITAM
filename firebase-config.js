/**
 * SheSafe - Firebase Configuration & Initialization
 * Registered Web App: SheSafeWebsite
 *
 * This file connects the SheSafe frontend to your Firebase project.
 * It does NOT use invented or hard-coded fake credentials.
 * If config is provided via window.__FIREBASE_CONFIG__ or below, it initializes Firebase.
 */

// Firebase Project Configuration for Web App "SheSafeWebsite"
// Replace the empty strings below with your configuration from Firebase Console:
// (Firebase Console -> Project Settings -> General -> Your Apps -> SheSafeWebsite -> SDK setup and configuration)
const firebaseConfig = window.__FIREBASE_CONFIG__ || {
  apiKey: "AIzaSyCyQwZ-XaCi_s53YN_fzvlcRVgwrv6pasw",
  authDomain: "shesafebypritam08.firebaseapp.com",
  projectId: "shesafebypritam08",
  storageBucket: "shesafebypritam08.firebasestorage.app",
  messagingSenderId: "605553387459",
  appId: "1:605553387459:web:85fa108aa12b25cc5b7f76",
  measurementId: "G-940J0RWWR4"
};

/**
 * Checks if the Firebase configuration contains actual non-empty values
 */
function isFirebaseConfigured(config) {
  return Boolean(
    config &&
    typeof config.apiKey === 'string' &&
    config.apiKey.trim() !== '' &&
    !config.apiKey.includes('Dummy') &&
    typeof config.projectId === 'string' &&
    config.projectId.trim() !== ''
  );
}

// Track configuration status globally for UI prompts
window.__IS_FIREBASE_CONFIGURED__ = isFirebaseConfigured(firebaseConfig);

// Initialize Firebase App & Services when credentials are provided
if (typeof firebase !== 'undefined') {
  if (window.__IS_FIREBASE_CONFIGURED__) {
    if (!firebase.apps.length) {
      try {
        firebase.initializeApp(firebaseConfig);
        // Explicitly enforce local persistent session storage across reloads
        firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
          console.warn('Persistence setup warning:', err.message);
        });
        console.log('Firebase App & Auth successfully initialized for SheSafeWebsite.');
      } catch (err) {
        console.error('Firebase initialization error:', err.message);
      }
    }
  } else {
    console.warn(
      'Firebase configuration is pending. Please provide your real project credentials in firebase-config.js or via environment variables.'
    );
  }
} else {
  console.error('Firebase SDK not loaded. Ensure Firebase CDN scripts are included in index.html.');
}
