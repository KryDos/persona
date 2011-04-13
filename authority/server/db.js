const sqlite = require('sqlite'),
        path = require('path');

var db = new sqlite.Database();

db.open(path.join(path.dirname(__dirname), "authdb.sqlite"), function (error) {
  if (error) {
    console.log("Couldn't open database: " + error);
    throw error;
  }

  function createTable(name, sql) {
    db.execute(sql, function (error, rows) {
      if (error) {
        console.log("Couldn't create " + name + " table: " + error);
        throw error;
      }
    });
  }

  createTable('users',  "CREATE TABLE IF NOT EXISTS users  ( id INTEGER PRIMARY KEY, password TEXT )");
  createTable('emails', "CREATE TABLE IF NOT EXISTS emails ( id INTEGER PRIMARY KEY, user INTEGER, address TEXT UNIQUE )");
  createTable('keys',   "CREATE TABLE IF NOT EXISTS keys   ( id INTEGER PRIMARY KEY, email INTEGER, key TEXT, expires INTEGER )");
});

// half created user accounts (pending email verification)
// OR
// half added emails (pending verification)
var g_staged = {
};

// an email to secret map for efficient fulfillment of isStaged queries
var g_stagedEmails = {
};

function executeTransaction(statements, cb) {
  function executeTransaction2(statements, cb) {
    if (statements.length == 0) cb();
    else {
      var s = statements.shift();
      db.execute(s[0], s[1], function(err, rows) {
        if (err) cb(err);
        else executeTransaction2(statements, cb);
      });
    }
  }

  db.execute('BEGIN', function(err, rows) {
    executeTransaction2(statements, function(err) {
      if (err) cb(err);
      else db.execute('COMMIT', function(err, rows) {
        cb(err);
      });
    });
  });
}

function emailToUserID(email, cb) {
  db.execute(
    'SELECT users.id FROM emails, users WHERE emails.address = ? AND users.id == emails.user',
    [ email ],
    function (err, rows) {
      if (rows && rows.length == 1) {
        cb(rows[0].id);
      } else {
        if (err) console.log("database error: " + err);
        cb(undefined);
      }
    });
}

exports.findByEmail = function(email) {
  for (var i = 0; i < g_users.length; i++) {
    for (var j = 0; j < g_users[i].emails.length; j++) {
      if (email === g_users[i].emails[j]) return g_users[i];
    }
  }
  return undefined;
};

exports.emailKnown = function(email, cb) {
  db.execute(
    "SELECT id FROM emails WHERE address = ?",
    [ email ],
    function(error, rows) {
      cb(rows.length > 0);
    });
};

exports.isStaged = function(email) {
  return g_stagedEmails.hasOwnProperty(email);
};

function generateSecret() {
  var str = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (var i=0; i < 32; i++) {
    str += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return str;
}

exports.addEmailToAccount = function(existing_email, email, pubkey, cb) {
  emailToUserID(existing_email, function(userID) {
    if (userID == undefined) {
      cb("no such email: " + existing_email, undefined);
    } else {
        executeTransaction([
          [ "INSERT INTO emails (user, address) VALUES(?,?)", [ userID, email ] ],
          [ "INSERT INTO keys (email, key, expires) VALUES(last_insert_rowid(),?,?)",
            [ pubkey, ((new Date()).getTime() + (14 * 24 * 60 * 60 * 1000)) ]
          ]
        ], function (error) {
          if (error) cb(error);
          else cb();
        });
    }
  });
}

/* takes an argument object including email, pass, and pubkey. */
exports.stageUser = function(obj) {
  var secret = generateSecret();
  // overwrite previously staged users
  g_staged[secret] = {
    type: "add_account",
    email: obj.email,
    pubkey: obj.pubkey,
    pass: obj.pass
  };
  g_stagedEmails[obj.email] = secret;
  return secret;
};

/* takes an argument object including email, pass, and pubkey. */
exports.stageEmail = function(existing_email, new_email, pubkey) {
  var secret = generateSecret();
  // overwrite previously staged users
  g_staged[secret] = {
    type: "add_email",
    existing_email: existing_email,
    email: new_email,
    pubkey: pubkey
  };
  g_stagedEmails[new_email] = secret;
  return secret;
};

/* invoked when a user clicks on a verification URL in their email */ 
exports.gotVerificationSecret = function(secret, cb) {
  if (!g_staged.hasOwnProperty(secret)) cb("unknown secret");

  // simply move from staged over to the emails "database"
  var o = g_staged[secret];
  delete g_staged[secret];
  delete g_stagedEmails[o.email];
  if (o.type === 'add_account') {
    exports.emailKnown(o.email, function(known) {
      if (known) cb("email already exists!");
      else {
        executeTransaction([
          [ "INSERT INTO users (password) VALUES(?)", [ o.pass ] ] ,
          [ "INSERT INTO emails (user, address) VALUES(last_insert_rowid(),?)", [ o.email ] ],
          [ "INSERT INTO keys (email, key, expires) VALUES(last_insert_rowid(),?,?)",
            [ o.pubkey, ((new Date()).getTime() + (14 * 24 * 60 * 60 * 1000)) ]
          ]
        ], function (error) {
          if (error) cb(error);
          else cb();
        });
      }
    });
  } else if (o.type === 'add_email') {
    exports.addEmailToAccount(o.existing_email, o.email, o.pubkey, cb);
  } else {
    cb("internal error");
  }
};

/* takes an argument object including email, pass, and pubkey. */
exports.checkAuth = function(email, pass, cb) {
  db.execute("SELECT users.id FROM emails, users WHERE users.id = emails.user AND emails.address = ? AND users.password = ?",
             [ email, pass ],
             function (error, rows) {
               cb(rows.length === 1);
             });
};

/* a high level operation that attempts to sync a client's view with that of the
 * server.  email is the identity of the authenticated channel with the user,
 * identities is a map of email -> pubkey.
 * We'll return an object that expresses three different types of information:
 * there are several things we need to express:
 * 1. emails that the client knows about but we do not
 * 2. emails that we know about and the client does not
 * 3. emails that we both know about but who need to be re-keyed
 * NOTE: it's not neccesary to differentiate between #2 and #3, as the client action
 *       is the same (regen keypair and tell us about it).
 */
exports.getSyncResponse = function(email, identities, cb) {
  var respBody = {
    unknown_emails: [ ],
    key_refresh: [ ]
  };

  // get the user id associated with this account 
  emailToUserID(email, function(userID) {
    if (userID === undefined) {
      cb("no such email: " + email);
      return;
    }
    db.execute(
      'SELECT address FROM emails WHERE ? = user',
      [ userID ],
      function (err, rows) {
        if (err) cb(err);
        else {
          var emails = [ ];
          for (var i = 0; i < rows.length; i++) emails.push(rows[i].address);

          // #1
          for (var e in identities) {
            if (emails.indexOf(e) == -1) respBody.unknown_emails.push(e);
          }

          // #2
          for (var e in emails) {
            e = emails[e];
            if (!identities.hasOwnProperty(e)) respBody.key_refresh.push(e);
          }

          // #3
          // XXX todo

          cb(undefined, respBody); 
        }
      });
  });
};
