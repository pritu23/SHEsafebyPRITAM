/**
 * SheSafe - Cloud Functions Backend for Secure Safety Group Management
 * 
 * Enforces server-side validation:
 * 1. Authenticated users only.
 * 2. Secure HMAC-SHA256 password hashing with timing-safe comparison.
 * 3. Atomic transaction enforcement of the strict 4-member limit.
 * 4. Zero exposure of password hashes or private security documents to clients.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

/**
 * Helper: Securely hash join password using HMAC-SHA256 with per-group salt
 */
function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

/**
 * 1. CREATE SAFETY GROUP (Callable Function)
 * Atomically creates group metadata, security credentials, creator record, and user pointer.
 */
exports.createSafetyGroup = functions.https.onCall(async (data, context) => {
  // 1. Verify authentication
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be authenticated with Firebase to create a Safety Group.'
    );
  }

  const uid = context.auth.uid;
  const groupName = (data.groupName || '').trim();
  const groupId = (data.groupId || '').trim().toUpperCase();
  const joinPassword = (data.joinPassword || '').trim();

  // 2. Validate inputs
  if (!groupName || groupName.length > 40) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Group name is required and must be between 1 and 40 characters.'
    );
  }

  if (!groupId || !/^GRP-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(groupId)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid Group ID format. Must be GRP-XXXX-XXXX.'
    );
  }

  if (!joinPassword || joinPassword.length < 4) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Join password must be at least 4 characters.'
    );
  }

  // 3. Fetch user profile for display name
  let displayName = 'Guardian';
  try {
    const userRecord = await admin.auth().getUser(uid);
    displayName = userRecord.displayName || (userRecord.email ? userRecord.email.split('@')[0] : 'Guardian');
  } catch (e) {
    console.warn('Could not fetch user record display name:', e.message);
  }

  const groupRef = db.collection('groups').doc(groupId);
  const securityRef = groupRef.collection('private').doc('security');
  const memberRef = groupRef.collection('members').doc(uid);
  const userRef = db.collection('users').doc(uid);

  // 4. Generate salt and hash
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(joinPassword, salt);

  // 5. Execute atomic transaction
  await db.runTransaction(async (transaction) => {
    // Check group does not already exist
    const groupDoc = await transaction.get(groupRef);
    if (groupDoc.exists) {
      throw new functions.https.HttpsError(
        'already-exists',
        'A Safety Group with this ID already exists. Please generate a new ID.'
      );
    }

    // Check user is not already in an active group
    const userDoc = await transaction.get(userRef);
    if (userDoc.exists && userDoc.data().currentGroupId) {
      const existingGroupId = userDoc.data().currentGroupId;
      const existingGroupDoc = await transaction.get(db.collection('groups').doc(existingGroupId));
      if (existingGroupDoc.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'You are already a member of an active Safety Group. You must leave it before creating a new one.'
        );
      }
    }

    // Write groups/{groupId}
    transaction.set(groupRef, {
      groupId: groupId,
      groupName: groupName,
      createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      memberCount: 1,
      maxMembers: 4,
      membersList: [uid]
    });

    // Write groups/{groupId}/private/security (Admin-only, completely blocked from client reads)
    transaction.set(securityRef, {
      passwordHash: passwordHash,
      salt: salt,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Write groups/{groupId}/members/{uid}
    transaction.set(memberRef, {
      userId: uid,
      displayName: displayName,
      role: 'creator',
      joinedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update users/{uid}
    transaction.set(userRef, {
      currentGroupId: groupId,
      displayName: displayName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return {
    success: true,
    groupId: groupId,
    groupName: groupName,
    message: `Safety Group "${groupName}" successfully created!`
  };
});

/**
 * 2. JOIN SAFETY GROUP (Callable Function)
 * Atomically validates credentials, checks the 4-member limit, and admits the member.
 */
exports.joinSafetyGroup = functions.https.onCall(async (data, context) => {
  // 1. Verify authentication
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be authenticated with Firebase to join a Safety Group.'
    );
  }

  const uid = context.auth.uid;
  const groupId = (data.groupId || '').trim().toUpperCase();
  const joinPassword = (data.joinPassword || '').trim();

  if (!groupId || !joinPassword) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Both Group ID and Join Password are required.'
    );
  }

  let displayName = 'Guardian';
  try {
    const userRecord = await admin.auth().getUser(uid);
    displayName = userRecord.displayName || (userRecord.email ? userRecord.email.split('@')[0] : 'Guardian');
  } catch (e) {
    console.warn('Could not fetch user record display name:', e.message);
  }

  const groupRef = db.collection('groups').doc(groupId);
  const securityRef = groupRef.collection('private').doc('security');
  const memberRef = groupRef.collection('members').doc(uid);
  const userRef = db.collection('users').doc(uid);

  let admittedGroupName = 'Safety Group';

  // 2. Execute atomic transaction
  await db.runTransaction(async (transaction) => {
    // Step A: Check group existence
    const groupDoc = await transaction.get(groupRef);
    if (!groupDoc.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        `Safety Group "${groupId}" does not exist. Please check the Group ID.`
      );
    }

    const groupData = groupDoc.data();
    admittedGroupName = groupData.groupName || 'Safety Group';

    // Step B: Atomically enforce 4-member limit
    if (groupData.memberCount >= 4 || (groupData.membersList && groupData.membersList.length >= 4)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This Safety Group has reached its maximum capacity of 4 members.'
      );
    }

    // Step C: Check duplicate membership
    if (groupData.membersList && groupData.membersList.includes(uid)) {
      throw new functions.https.HttpsError(
        'already-exists',
        'You are already an active member of this Safety Group.'
      );
    }

    // Step D: Verify credentials securely
    const securityDoc = await transaction.get(securityRef);
    if (!securityDoc.exists) {
      throw new functions.https.HttpsError(
        'internal',
        'Group security credentials document is missing.'
      );
    }

    const { passwordHash: storedHash, salt } = securityDoc.data();
    const candidateHash = hashPassword(joinPassword, salt);

    // Timing-safe comparison to prevent side-channel timing attacks
    const candidateBuf = Buffer.from(candidateHash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');

    if (candidateBuf.length !== storedBuf.length || !crypto.timingSafeEqual(candidateBuf, storedBuf)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Invalid join credentials. The password does not match.'
      );
    }

    // Step E: Commit member addition atomically
    transaction.update(groupRef, {
      memberCount: admin.firestore.FieldValue.increment(1),
      membersList: admin.firestore.FieldValue.arrayUnion(uid)
    });

    transaction.set(memberRef, {
      userId: uid,
      displayName: displayName,
      role: 'member',
      joinedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(userRef, {
      currentGroupId: groupId,
      displayName: displayName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return {
    success: true,
    groupId: groupId,
    groupName: admittedGroupName,
    message: `Successfully joined Safety Group "${admittedGroupName}"!`
  };
});

/**
 * 3. LEAVE SAFETY GROUP (Callable Function)
 * Atomically removes member, updates counter, and cleans up group if empty/creator disbands.
 */
exports.leaveSafetyGroup = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be authenticated to leave a Safety Group.'
    );
  }

  const uid = context.auth.uid;
  const groupId = (data.groupId || '').trim().toUpperCase();

  if (!groupId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Group ID is required.'
    );
  }

  const groupRef = db.collection('groups').doc(groupId);
  const securityRef = groupRef.collection('private').doc('security');
  const memberRef = groupRef.collection('members').doc(uid);
  const userRef = db.collection('users').doc(uid);

  await db.runTransaction(async (transaction) => {
    const groupDoc = await transaction.get(groupRef);
    if (!groupDoc.exists) {
      // Group already gone; clean up user pointer
      transaction.update(userRef, {
        currentGroupId: admin.firestore.FieldValue.delete()
      });
      return;
    }

    const groupData = groupDoc.data();
    const isMember = groupData.membersList && groupData.membersList.includes(uid);
    if (!isMember) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You are not a member of this Safety Group.'
      );
    }

    const isCreator = groupData.createdBy === uid;
    const isLastMember = (groupData.memberCount <= 1);

    if (isCreator && isLastMember) {
      // Disband entire group
      transaction.delete(memberRef);
      transaction.delete(securityRef);
      transaction.delete(groupRef);
    } else {
      // Remove self from group
      transaction.update(groupRef, {
        memberCount: admin.firestore.FieldValue.increment(-1),
        membersList: admin.firestore.FieldValue.arrayRemove(uid)
      });
      transaction.delete(memberRef);
    }

    transaction.update(userRef, {
      currentGroupId: admin.firestore.FieldValue.delete()
    });
  });

  return {
    success: true,
    message: 'You have left the Safety Group.'
  };
});
