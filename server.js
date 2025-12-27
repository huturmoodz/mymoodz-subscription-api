const express = require('express');

const app = express();
app.use(express.json());

app.post('/change-gift', (req, res) => {
  const { subscription_id, selected_free_gift } = req.body;
  console.log('Change gift request:', subscription_id, selected_free_gift);

  if (!subscription_id || !selected_free_gift) {
    return res.status(400).json({ error: 'Missing data' });
  }

  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
