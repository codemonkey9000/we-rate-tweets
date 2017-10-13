const express = require('express');
const Twitter = require('twitter');
const nunjucks = require('nunjucks');
const passport = require('passport');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const algoliasearch = require('algoliasearch');
const passportTwitter = require('passport-twitter');

// only do if not running on glitch
if (!process.env.PROJECT_DOMAIN) {
  // read environment variables (only necessary locally, not on Glitch)
  require('dotenv').config();
}

// put twitter and algolia functions in separate files for readability
const twitterHelper = require('./server/helpers/twitter');
const algoliaHelper = require('./server/helpers/algolia');

// configure the twitter client
const twitterClient = new Twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

// create the algolia client from env variables
const algoliaClient = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY);

// use passport for twitter oauth authentication
// pass appropriate keys for twitter authentication
const TwitterStrategy = passportTwitter.Strategy;
passport.use(new TwitterStrategy({
  consumerKey: process.env.TWITTER_CONSUMER_KEY,
  consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
  callbackURL: process.env.PROJECT_DOMAIN ? `https://${process.env.PROJECT_DOMAIN}.glitch.me/login/twitter/return` : 'http://localhost:3000/login/twitter/return'
}, (token, tokenSecret, profile, cb) => {
  return cb(null, profile);
}));
passport.serializeUser((user, done) => {
  done(null, user.username);
});
passport.deserializeUser((username, done) => {
  done(null, { username: username });
});

// create the express app
const app = express();

// configure express and passport
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cookieSession({
  name: 'we-rate-cookies',
  secret: 'we-love-cookies'
}));
app.use(passport.initialize());
app.use(passport.session());

// only run this section this if not on glitch
if (!process.env.PROJECT_DOMAIN) {
  // reload a connected HTML page automatically if HTML/CSS/JS changes
  const reload = require('reload');
  const watch = require('watch');
  const reloadServer = reload(app);
  watch.watchTree(__dirname + '/public', reloadServer.reload);
  watch.watchTree(__dirname + '/views', reloadServer.reload);

  // don't cache templates b/c server restart is needed to pickup changes
  nunjucks.configure('views', {
    app: app, noCache: true
  });
}

// index route
app.get('/', (request, response) => {
  response.send(nunjucks.render('index.html'));
});

// processing route, for the user to wait while we index tweets
app.get('/patience', (request, response) => {
  response.send(nunjucks.render('patience.html'));
});

// clear the cookie if the user logs off
app.get('/logout', (request, response) => {
  request.logout();
  response.redirect('/');
});

// send to twitter to authenticate
app.get('/auth/twitter', passport.authenticate('twitter'));

// receive authenticated twitter user and index tweets
app.get('/login/twitter/return', passport.authenticate('twitter', { failureRedirect: '/' }), (request, response) => {
  response.redirect('/patience');
});

app.post('/tweets/index', requireUser, (request, response) => {
  // create and configure the algolia index
  algoliaHelper.pushAlgoliaIndexSettings(request.user, algoliaClient).then(() => {
    // fetch the user's twitter timeline and index it with algolia
    return fetchAndIndexTweets(request, response).then(() => {
      response.json({ ok: true });
    });
  }).catch((err) => {
    console.error('twitter to algolia failed', err);
    response.status(500).json({ error: err });
  });
});

// primary page for search tweets, accessible to an authenticated user
app.get('/tweets', requireUser, (request, response) => {
  response.send(nunjucks.render('tweets.html', { user: request.user,
    algolia: {
      app_id: process.env.ALGOLIA_APP_ID,
      search_api_key: process.env.ALGOLIA_SEARCH_API_KEY
    } }));
});

// listen for requests :)
const listener = app.listen(process.env.PORT, () => {
  console.log('Your app is listening on port ' + listener.address().port);
});

function requireUser(request, response, next) {
  if (!request.isAuthenticated()) {
    response.redirect('/');
  } else {
    next();
  }
};

// helper function to push data from twitter to algolia
function fetchAndIndexTweets(request, response) {
  return twitterHelper.getTweets(request.user, twitterClient).then(tweets => {
    return algoliaHelper.indexTweets(request.user, tweets, algoliaClient);
  });
}
