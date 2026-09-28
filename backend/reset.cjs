require('dotenv').config();
const bcrypt = require('bcrypt');
const neo4j = require('neo4j-driver');
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
const session = driver.session();
bcrypt.hash('admin123', 10).then(hash => {
  session.run('MATCH (i:Investigator {email: "admin@cybercell.gov.in"}) SET i.passwordHash = $hash', {hash}).then(() => {
    console.log('Password updated');
    driver.close();
  });
});
